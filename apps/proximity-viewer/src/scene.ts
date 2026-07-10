/*
 * Copyright 2026 nicanadian
 * Licensed under the Apache License, Version 2.0.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { AbsolutePair, AbsoluteSample } from "./absolute.js";
import type { InterpolatedReplayState, ParsedReplay, QuaternionXyzw } from "./replay.js";

export type VehicleRole = "target" | "chaser";
export type FocusMode = "overview" | VehicleRole;
export type PresentationMode = "absolute" | "relative";

export interface OverlayVisibility {
  readonly axes: boolean;
  readonly corridor: boolean;
  readonly keepOut: boolean;
  readonly trail: boolean;
}

const COLORS = {
  radial: 0xff786a,
  inTrack: 0x54d7c5,
  crossTrack: 0xf2bc55,
  keepOut: 0xff786a,
  corridor: 0x54d7c5,
  trail: 0xe9edf4,
};

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material.dispose();
  });
}

function makeStars(): THREE.Points {
  const count = 900;
  const positions = new Float32Array(count * 3);
  let seed = 0x5f3759df;
  const random = (): number => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let index = 0; index < count; index += 1) {
    const vector = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5)
      .normalize()
      .multiplyScalar(260 + random() * 80);
    positions.set([vector.x, vector.y, vector.z], index * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ color: 0xaeb8ca, size: 0.42, sizeAttenuation: true }),
  );
}

export function bodyToLvlhQuaternion(
  bodyToEci: QuaternionXyzw,
  target: AbsoluteSample,
): THREE.Quaternion {
  const radial = new THREE.Vector3(
    target.position.xKm,
    target.position.yKm,
    target.position.zKm,
  ).normalize();
  const velocity = new THREE.Vector3(target.velocity.xKm, target.velocity.yKm, target.velocity.zKm);
  const crossTrack = new THREE.Vector3().crossVectors(radial, velocity).normalize().negate();
  const inTrack = new THREE.Vector3().crossVectors(crossTrack, radial).normalize();
  const lvlhToEci = new THREE.Matrix4().set(
    radial.x,
    inTrack.x,
    crossTrack.x,
    0,
    radial.y,
    inTrack.y,
    crossTrack.y,
    0,
    radial.z,
    inTrack.z,
    crossTrack.z,
    0,
    0,
    0,
    0,
    1,
  );
  const eciToLvlh = new THREE.Quaternion().setFromRotationMatrix(lvlhToEci).invert();
  const bodyQuaternion = new THREE.Quaternion(bodyToEci.x, bodyToEci.y, bodyToEci.z, bodyToEci.w);
  return eciToLvlh.multiply(bodyQuaternion).normalize();
}

export class ProximityScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.05, 900);
  private readonly controls: OrbitControls;
  private readonly loader = new GLTFLoader();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly resizeObserver: ResizeObserver;
  private readonly targetRoot = new THREE.Group();
  private readonly chaserRoot = new THREE.Group();
  private readonly relativeRoot = new THREE.Group();
  private readonly absoluteRoot = new THREE.Group();
  private readonly absoluteTarget = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 16, 12),
    new THREE.MeshBasicMaterial({ color: COLORS.inTrack }),
  );
  private readonly absoluteChaser = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 16, 12),
    new THREE.MeshBasicMaterial({ color: COLORS.radial }),
  );
  private readonly axesRoot = new THREE.Group();
  private readonly corridorRoot = new THREE.Group();
  private readonly keepOutRoot = new THREE.Group();
  private readonly trailRoot = new THREE.Group();
  private focusMode: FocusMode = "overview";
  private presentationMode: PresentationMode = "relative";
  private selectionHandler?: (role: VehicleRole) => void;

  constructor(
    private readonly host: HTMLElement,
    private readonly keepOutRadiusM: number,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.setAttribute("aria-label", "Target-relative proximity scene");
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x080b10);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(58, -112, 54);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.target.set(0, -28, 0);

    this.scene.add(
      new THREE.HemisphereLight(0x9db8e8, 0x101219, 1.3),
      this.relativeRoot,
      this.absoluteRoot,
      makeStars(),
    );
    this.relativeRoot.add(
      this.targetRoot,
      this.chaserRoot,
      this.axesRoot,
      this.corridorRoot,
      this.keepOutRoot,
      this.trailRoot,
    );
    this.absoluteRoot.visible = false;
    const sun = new THREE.DirectionalLight(0xfff0d9, 4.2);
    sun.position.set(40, -15, 55);
    const earthshine = new THREE.DirectionalLight(0x4f83b8, 1.8);
    earthshine.position.set(-25, 5, -12);
    this.scene.add(sun, earthshine);

    this.buildAxes();
    this.buildEnvelope();
    this.renderer.domElement.addEventListener("click", this.handleClick);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  onSelection(handler: (role: VehicleRole) => void): void {
    this.selectionHandler = handler;
  }

  setReplay(replay: ParsedReplay): void {
    this.trailRoot.clear();
    const points = replay.samples.map(
      (sample) => new THREE.Vector3(sample.position.x, sample.position.y, sample.position.z),
    );
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: COLORS.trail,
      transparent: true,
      opacity: 0.72,
    });
    this.trailRoot.add(new THREE.Line(geometry, material));
  }

  setAbsolute(pair: AbsolutePair): void {
    this.absoluteRoot.clear();
    const earthRadius = 28;
    const scale = earthRadius / 6378.137;
    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(earthRadius, 48, 32),
      new THREE.MeshStandardMaterial({
        color: 0x183b52,
        roughness: 0.92,
        metalness: 0,
        emissive: 0x07131d,
      }),
    );
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(earthRadius * 1.025, 48, 32),
      new THREE.MeshBasicMaterial({
        color: 0x54d7c5,
        transparent: true,
        opacity: 0.07,
        side: THREE.BackSide,
      }),
    );
    const track = (samples: AbsolutePair["target"], color: number) =>
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
          samples.map(
            (sample) =>
              new THREE.Vector3(
                sample.position.xKm * scale,
                sample.position.yKm * scale,
                sample.position.zKm * scale,
              ),
          ),
        ),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }),
      );
    this.absoluteRoot.add(
      earth,
      atmosphere,
      track(pair.target, COLORS.inTrack),
      track(pair.chaser, COLORS.radial),
      this.absoluteTarget,
      this.absoluteChaser,
    );
    this.absoluteRoot.userData.scale = scale;
  }

  setPresentationMode(mode: PresentationMode): void {
    this.presentationMode = mode;
    this.relativeRoot.visible = mode === "relative";
    this.absoluteRoot.visible = mode === "absolute";
    if (mode === "absolute") {
      this.camera.position.set(58, -66, 42);
      this.controls.target.set(0, 0, 0);
    } else {
      this.setFocus(this.focusMode);
    }
    this.controls.update();
  }

  async loadVehicle(role: VehicleRole, uri: string): Promise<void> {
    const root = role === "target" ? this.targetRoot : this.chaserRoot;
    const previous = [...root.children];
    const gltf = await this.loader.loadAsync(uri);
    for (const child of previous) {
      root.remove(child);
      disposeObject(child);
    }
    gltf.scene.traverse((child) => {
      child.userData.vehicleRole = role;
      if (child instanceof THREE.Mesh) {
        child.castShadow = false;
        child.receiveShadow = false;
      }
    });
    root.add(gltf.scene);
  }

  async loadMountedRobot(uri: string, baseFrame: string): Promise<void> {
    const mount = this.chaserRoot.getObjectByName(baseFrame);
    if (!mount) throw new Error(`chaser visual proxy is missing robot mount ${baseFrame}`);
    const gltf = await this.loader.loadAsync(uri);
    gltf.scene.name = "mounted-servicing-robot";
    gltf.scene.traverse((child) => {
      child.userData.vehicleRole = "chaser";
      if (child instanceof THREE.Mesh) {
        child.castShadow = false;
        child.receiveShadow = false;
      }
    });
    mount.add(gltf.scene);
  }

  setFocus(mode: FocusMode): void {
    this.focusMode = mode;
    if (mode === "overview") {
      this.camera.position.set(58, -112, 54);
      this.controls.target.set(0, -28, 0);
    } else if (mode === "target") {
      this.camera.position.set(18, -20, 12);
      this.controls.target.set(0, 0, 0);
    }
    this.controls.update();
  }

  setOverlays(visibility: OverlayVisibility): void {
    this.axesRoot.visible = visibility.axes;
    this.corridorRoot.visible = visibility.corridor;
    this.keepOutRoot.visible = visibility.keepOut;
    this.trailRoot.visible = visibility.trail;
  }

  render(
    state: InterpolatedReplayState,
    absolute: { readonly chaser: AbsoluteSample; readonly target: AbsoluteSample },
  ): void {
    const { x, y, z } = state.position;
    this.chaserRoot.position.set(x, y, z);
    this.chaserRoot.quaternion.copy(
      bodyToLvlhQuaternion(state.chaserAttitudeBodyToEci, absolute.target),
    );
    this.targetRoot.quaternion.copy(
      bodyToLvlhQuaternion(state.targetAttitudeBodyToEci, absolute.target),
    );
    if (this.focusMode === "chaser") {
      this.controls.target.lerp(this.chaserRoot.position, 0.14);
      const offset = new THREE.Vector3(15, -18, 11);
      this.camera.position.lerp(this.chaserRoot.position.clone().add(offset), 0.08);
    }
    const scale = Number(this.absoluteRoot.userData.scale ?? 1);
    this.absoluteChaser.position.set(
      absolute.chaser.position.xKm * scale,
      absolute.chaser.position.yKm * scale,
      absolute.chaser.position.zKm * scale,
    );
    this.absoluteTarget.position.set(
      absolute.target.position.xKm * scale,
      absolute.target.position.yKm * scale,
      absolute.target.position.zKm * scale,
    );
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("click", this.handleClick);
    disposeObject(this.scene);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private readonly handleClick = (event: MouseEvent): void => {
    if (this.presentationMode !== "relative") return;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster
      .intersectObjects([this.targetRoot, this.chaserRoot], true)
      .find((candidate) => candidate.object.userData.vehicleRole !== undefined);
    const role = hit?.object.userData.vehicleRole;
    if (role === "target" || role === "chaser") this.selectionHandler?.(role);
  };

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private buildAxes(): void {
    const origin = new THREE.Vector3(0, 0, 0);
    this.axesRoot.add(
      new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), origin, 13, COLORS.radial, 1.1, 0.5),
      new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), origin, 13, COLORS.inTrack, 1.1, 0.5),
      new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), origin, 13, COLORS.crossTrack, 1.1, 0.5),
    );
  }

  private buildEnvelope(): void {
    const keepOut = new THREE.Mesh(
      new THREE.SphereGeometry(this.keepOutRadiusM, 28, 18),
      new THREE.MeshBasicMaterial({
        color: COLORS.keepOut,
        wireframe: true,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      }),
    );
    this.keepOutRoot.add(keepOut);

    const corridor = new THREE.Mesh(
      new THREE.CylinderGeometry(4.5, 4.5, 82, 36, 1, true),
      new THREE.MeshBasicMaterial({
        color: COLORS.corridor,
        wireframe: true,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    );
    corridor.position.y = -41;
    this.corridorRoot.add(corridor);
  }
}
