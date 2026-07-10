/*
 * Copyright 2026 nicanadian
 * Licensed under the Apache License, Version 2.0.
 */

import { MissionClock, TimelineMarks } from "@dvgl/core";
import {
  ChevronLeft,
  ChevronRight,
  CircleDot,
  createIcons,
  Focus,
  Pause,
  Play,
  RotateCcw,
} from "lucide";
import "./style.css";
import { absoluteStateAt, parseAbsolutePair } from "./absolute.js";
import { parseReplay, replayStateAt } from "./replay.js";
import {
  type FocusMode,
  type OverlayVisibility,
  type PresentationMode,
  ProximityScene,
  type VehicleRole,
} from "./scene.js";
import {
  type PackModel,
  packAssetUrl,
  packFileDigest,
  parsePackScenario,
  parseViewerPack,
  type ViewerPack,
} from "./viewerPack.js";

interface AssetMetadata {
  readonly model_name: string;
  readonly archetype: string;
  readonly accuracy_tier: string;
  readonly source_basis: string;
  readonly not_official_model: boolean;
}

interface ViewerAsset {
  readonly id: string;
  readonly label: string;
  readonly role: VehicleRole;
  readonly uri: string;
  readonly sha256: string;
  readonly metadata: AssetMetadata;
}

const ICONS = { ChevronLeft, ChevronRight, CircleDot, Focus, Pause, Play, RotateCcw };
const PACK_ROOT = "/packs/pdb-native";

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing UI element ${selector}`);
  return found;
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function viewerAsset(pack: ViewerPack, role: VehicleRole, model: PackModel): ViewerAsset {
  const path = model.tiers.high;
  return {
    id: role,
    label: model.name,
    role,
    uri: packAssetUrl(PACK_ROOT, path),
    sha256: packFileDigest(pack, path),
    metadata: {
      model_name: model.name,
      archetype: role,
      accuracy_tier: model.accuracy_tier,
      source_basis: model.source_basis,
      not_official_model: model.not_official_model,
    },
  };
}

function formatPhase(phase: string): string {
  return phase.replaceAll("_", " ");
}

function formatElapsed(seconds: number): string {
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${String(minutes).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}

function renderIcons(): void {
  createIcons({ icons: ICONS, attrs: { "stroke-width": 1.8 } });
}

function appMarkup(): string {
  return `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand-block">
          <span class="product-mark" aria-hidden="true"></span>
          <div>
            <strong>dv.gl</strong>
            <span>Proximity Viewer</span>
          </div>
        </div>
        <div class="mission-title">
          <span id="mission-name">Loading mission</span>
          <span id="contract-name">replay/1.0</span>
        </div>
        <div class="authority-state">
          <span class="status-light"></span>
          Read-only evidence
        </div>
      </header>

      <main class="workspace">
        <aside class="side-panel left-panel" aria-label="Scene controls">
          <section class="panel-section">
            <div class="section-heading">Scene</div>
            <div class="mode-control" role="group" aria-label="Presentation frame">
              <button type="button" data-presentation="absolute">Absolute ECI</button>
              <button type="button" data-presentation="relative" class="active">Relative LVLH</button>
            </div>
            <label class="field-label" for="target-model">Target model</label>
            <select id="target-model"></select>
            <label class="field-label" for="view-mode">Camera</label>
            <select id="view-mode">
              <option value="overview">Approach overview</option>
              <option value="target">Target focus</option>
              <option value="chaser">Chaser follow</option>
            </select>
          </section>

          <section class="panel-section" id="relative-overlays">
            <div class="section-heading">Overlays</div>
            <label class="toggle-row"><input id="overlay-trail" type="checkbox" checked />Trajectory</label>
            <label class="toggle-row"><input id="overlay-corridor" type="checkbox" checked />Approach corridor</label>
            <label class="toggle-row"><input id="overlay-keepout" type="checkbox" checked />Keep-out envelope</label>
            <label class="toggle-row"><input id="overlay-axes" type="checkbox" checked />LVLH axes</label>
          </section>

          <section class="panel-section frame-section" id="relative-frame-info">
            <div class="section-heading">LVLH / RIC</div>
            <div class="axis-row"><span class="axis-swatch radial"></span><span>R</span><small>Radial</small></div>
            <div class="axis-row"><span class="axis-swatch intrack"></span><span>I</span><small>In-track</small></div>
            <div class="axis-row"><span class="axis-swatch cross"></span><span>C</span><small>Cross-track</small></div>
          </section>
        </aside>

        <section class="viewer-column" aria-label="3D proximity replay">
          <div id="viewport">
            <div class="viewport-hud">
              <span id="phase-pill">--</span>
              <span id="absolute-time">--</span>
            </div>
            <div id="loading-state" role="status">Loading visual proxies</div>
          </div>

          <div class="playback-bar">
            <button id="restart" class="icon-button" type="button" title="Restart replay" aria-label="Restart replay"><i data-lucide="rotate-ccw"></i></button>
            <button id="previous-mark" class="icon-button" type="button" title="Previous phase" aria-label="Previous phase"><i data-lucide="chevron-left"></i></button>
            <button id="play-toggle" class="icon-button primary" type="button" title="Play replay" aria-label="Play replay"><i data-lucide="play"></i></button>
            <button id="next-mark" class="icon-button" type="button" title="Next phase" aria-label="Next phase"><i data-lucide="chevron-right"></i></button>
            <span id="elapsed-time" class="elapsed-time">00:00</span>
            <input id="time-slider" type="range" min="0" max="1" step="0.1" value="0" aria-label="Replay time" />
            <span id="duration-time" class="duration-time">00:00</span>
            <div class="rate-control" aria-label="Playback rate">
              <button type="button" data-rate="10">10x</button>
              <button type="button" data-rate="30" class="active">30x</button>
              <button type="button" data-rate="60">60x</button>
            </div>
          </div>
          <div id="phase-timeline" class="phase-timeline"></div>
        </section>

        <aside class="side-panel right-panel" aria-label="Evidence inspector">
          <section class="panel-section metric-section">
            <div class="section-heading" id="state-heading">Relative state</div>
            <div class="metric-primary"><span id="separation">--</span><small id="state-unit">m separation</small></div>
            <dl class="metric-grid">
              <dt id="axis-x-label">Radial</dt><dd id="radial-position">--</dd>
              <dt id="axis-y-label">In-track</dt><dd id="intrack-position">--</dd>
              <dt id="axis-z-label">Cross-track</dt><dd id="cross-position">--</dd>
            </dl>
            <div id="envelope-state" class="envelope-state">--</div>
          </section>

          <section class="panel-section">
            <div class="section-heading">Selection</div>
            <button id="selected-vehicle" class="selection-button" type="button">
              <i data-lucide="circle-dot"></i>
              <span><strong>Chaser</strong><small>Servicer visual proxy</small></span>
              <i data-lucide="focus"></i>
            </button>
          </section>

          <section class="panel-section provenance-section">
            <div class="section-heading">Asset provenance</div>
            <dl>
              <dt>Model</dt><dd id="asset-name">--</dd>
              <dt>Tier</dt><dd id="asset-tier">--</dd>
              <dt>Source</dt><dd id="asset-source">--</dd>
              <dt>Digest</dt><dd id="asset-digest">--</dd>
            </dl>
          </section>

          <section class="proxy-notice">
            Visual proxy only. Meshes do not define collision, keep-out, metrology, or execution authority.
          </section>
        </aside>
      </main>
    </div>`;
}

async function start(): Promise<void> {
  element<HTMLElement>("#app").innerHTML = appMarkup();
  renderIcons();

  const pack = parseViewerPack(await fetchJson(`${PACK_ROOT}/pack.json`));
  const [replayValue, scenarioValue, chaserValue, targetValue, gateValue] = await Promise.all([
    fetchJson(packAssetUrl(PACK_ROOT, pack.scenes.replay)),
    fetchJson(packAssetUrl(PACK_ROOT, pack.scenes.scenario)),
    fetchJson(packAssetUrl(PACK_ROOT, pack.evidence.absolute_chaser_ephemeris)),
    fetchJson(packAssetUrl(PACK_ROOT, pack.evidence.absolute_target_ephemeris)),
    fetchJson(packAssetUrl(PACK_ROOT, pack.evidence.proximity_gate)),
  ]);
  const replay = parseReplay(replayValue);
  const scenario = parsePackScenario(scenarioValue);
  const absolutePair = parseAbsolutePair(chaserValue, targetValue, gateValue);
  if (absolutePair.epochMs !== replay.epochMs || absolutePair.durationSec !== replay.durationSec) {
    throw new Error("absolute and relative evidence do not share one mission clock");
  }
  const clock = new MissionClock({
    epochMs: replay.epochMs,
    windowSeconds: replay.durationSec,
    rate: 30,
    loop: false,
  });
  const marks = new TimelineMarks(
    replay.samples.map((sample) => ({
      timeSec: sample.timeSec,
      category: sample.phase,
      label: formatPhase(sample.phase),
    })),
  );
  const scene = new ProximityScene(element<HTMLElement>("#viewport"), scenario.keepOutMarginM);
  scene.setReplay(replay);
  scene.setAbsolute(absolutePair);

  const chaser = viewerAsset(pack, "chaser", pack.models.chaser);
  const targets = [viewerAsset(pack, "target", pack.models.client)];
  let target = targets[0] as ViewerAsset;
  let selected: VehicleRole = "chaser";
  let presentationMode: PresentationMode = "relative";

  const targetSelect = element<HTMLSelectElement>("#target-model");
  for (const asset of targets) {
    const option = document.createElement("option");
    option.value = asset.id;
    option.textContent = asset.label;
    targetSelect.appendChild(option);
  }

  const setLoading = (loading: boolean, message = "Loading visual proxies"): void => {
    const loadingState = element<HTMLElement>("#loading-state");
    loadingState.textContent = message;
    loadingState.hidden = !loading;
  };

  await Promise.all([
    scene.loadVehicle("chaser", chaser.uri),
    scene.loadVehicle("target", target.uri),
  ]);
  setLoading(false);

  element<HTMLElement>("#mission-name").textContent = replay.missionId;
  element<HTMLElement>("#contract-name").textContent = replay.contractId;
  const slider = element<HTMLInputElement>("#time-slider");
  slider.max = String(replay.durationSec);
  element<HTMLElement>("#duration-time").textContent = formatElapsed(replay.durationSec);

  const phaseTimeline = element<HTMLElement>("#phase-timeline");
  for (const mark of marks.marks) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.time = String(mark.timeSec);
    button.style.setProperty("--phase-progress", `${(mark.timeSec / replay.durationSec) * 100}%`);
    button.innerHTML = `<span></span><small></small>`;
    const label = button.querySelector("small");
    if (label) label.textContent = mark.label ?? mark.category;
    button.addEventListener("click", () => clock.scrubTo(mark.timeSec));
    phaseTimeline.appendChild(button);
  }

  const overlayState = (): OverlayVisibility => ({
    trail: element<HTMLInputElement>("#overlay-trail").checked,
    corridor: element<HTMLInputElement>("#overlay-corridor").checked,
    keepOut: element<HTMLInputElement>("#overlay-keepout").checked,
    axes: element<HTMLInputElement>("#overlay-axes").checked,
  });
  for (const id of ["trail", "corridor", "keepout", "axes"]) {
    element<HTMLInputElement>(`#overlay-${id}`).addEventListener("change", () =>
      scene.setOverlays(overlayState()),
    );
  }
  scene.setOverlays(overlayState());

  document.querySelectorAll<HTMLButtonElement>("[data-presentation]").forEach((button) => {
    button.addEventListener("click", () => {
      presentationMode = button.dataset.presentation as PresentationMode;
      scene.setPresentationMode(presentationMode);
      const relative = presentationMode === "relative";
      element<HTMLElement>("#relative-overlays").hidden = !relative;
      element<HTMLElement>("#relative-frame-info").hidden = !relative;
      targetSelect.disabled = !relative;
      element<HTMLSelectElement>("#view-mode").disabled = !relative;
      document.querySelectorAll("[data-presentation]").forEach((candidate) => {
        candidate.classList.toggle("active", candidate === button);
      });
    });
  });

  const updateProvenance = (): void => {
    const asset = selected === "chaser" ? chaser : target;
    element<HTMLElement>("#asset-name").textContent = asset.label;
    element<HTMLElement>("#asset-tier").textContent = asset.metadata.accuracy_tier;
    element<HTMLElement>("#asset-source").textContent = asset.metadata.source_basis;
    element<HTMLElement>("#asset-digest").textContent = asset.sha256.slice(0, 12);
    const selectedButton = element<HTMLButtonElement>("#selected-vehicle");
    const title = selectedButton.querySelector("strong");
    const detail = selectedButton.querySelector("small");
    if (title) title.textContent = selected === "chaser" ? "Chaser" : "Target";
    if (detail) detail.textContent = asset.label;
  };

  const selectVehicle = (role: VehicleRole): void => {
    selected = role;
    updateProvenance();
  };
  scene.onSelection(selectVehicle);
  selectVehicle("chaser");

  targetSelect.addEventListener("change", async () => {
    const nextTarget = targets.find((asset) => asset.id === targetSelect.value);
    if (!nextTarget) return;
    setLoading(true, `Loading ${nextTarget.label}`);
    target = nextTarget;
    try {
      await scene.loadVehicle("target", target.uri);
      if (selected === "target") updateProvenance();
    } finally {
      setLoading(false);
    }
  });

  const viewMode = element<HTMLSelectElement>("#view-mode");
  viewMode.addEventListener("change", () => scene.setFocus(viewMode.value as FocusMode));
  element<HTMLButtonElement>("#selected-vehicle").addEventListener("click", () => {
    viewMode.value = selected;
    scene.setFocus(selected);
  });

  const playButton = element<HTMLButtonElement>("#play-toggle");
  const updatePlayButton = (): void => {
    playButton.innerHTML = `<i data-lucide="${clock.playing ? "pause" : "play"}"></i>`;
    playButton.title = clock.playing ? "Pause replay" : "Play replay";
    playButton.setAttribute("aria-label", playButton.title);
    renderIcons();
  };
  playButton.addEventListener("click", () => {
    if (clock.currentSeconds >= replay.durationSec) clock.scrubTo(0);
    if (clock.playing) clock.pause();
    else clock.play();
    updatePlayButton();
  });
  element<HTMLButtonElement>("#restart").addEventListener("click", () => clock.scrubTo(0));
  element<HTMLButtonElement>("#previous-mark").addEventListener("click", () => {
    const mark = marks.prev(clock.currentSeconds - 0.01);
    clock.scrubTo(mark?.timeSec ?? 0);
  });
  element<HTMLButtonElement>("#next-mark").addEventListener("click", () => {
    const mark = marks.next(clock.currentSeconds + 0.01);
    clock.scrubTo(mark?.timeSec ?? replay.durationSec);
  });
  slider.addEventListener("input", () => clock.scrubTo(Number(slider.value)));

  document.querySelectorAll<HTMLButtonElement>("[data-rate]").forEach((button) => {
    button.addEventListener("click", () => {
      clock.rate = Number(button.dataset.rate);
      document.querySelectorAll("[data-rate]").forEach((candidate) => {
        candidate.classList.toggle("active", candidate === button);
      });
    });
  });

  let previousFrame = performance.now();
  const absoluteFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    hour12: false,
  });
  const renderFrame = (now: number): void => {
    const delta = Math.min(0.1, (now - previousFrame) / 1000);
    previousFrame = now;
    clock.advance(delta);
    if (clock.playing && clock.currentSeconds >= replay.durationSec) {
      clock.pause();
      updatePlayButton();
    }
    const state = replayStateAt(replay, clock.currentSeconds);
    const absolute = absoluteStateAt(absolutePair, clock.currentSeconds);
    scene.render(state, absolute);
    slider.value = String(state.timeSec);
    element<HTMLElement>("#elapsed-time").textContent = formatElapsed(state.timeSec);
    element<HTMLElement>("#phase-pill").textContent = formatPhase(state.phase);
    element<HTMLElement>("#absolute-time").textContent =
      `${absoluteFormatter.format(clock.currentUnixMs())} UTC`;
    const envelope = element<HTMLElement>("#envelope-state");
    if (presentationMode === "relative") {
      element<HTMLElement>("#state-heading").textContent = "Relative state";
      element<HTMLElement>("#state-unit").textContent = "m separation";
      element<HTMLElement>("#axis-x-label").textContent = "Radial";
      element<HTMLElement>("#axis-y-label").textContent = "In-track";
      element<HTMLElement>("#axis-z-label").textContent = "Cross-track";
      element<HTMLElement>("#separation").textContent = state.separationM.toFixed(1);
      element<HTMLElement>("#radial-position").textContent = `${state.position.x.toFixed(1)} m`;
      element<HTMLElement>("#intrack-position").textContent = `${state.position.y.toFixed(1)} m`;
      element<HTMLElement>("#cross-position").textContent = `${state.position.z.toFixed(1)} m`;
      const clear = state.separationM >= scenario.keepOutMarginM;
      envelope.textContent = clear ? "Outside keep-out" : "Keep-out violation";
      envelope.classList.toggle("rejected", !clear);
    } else {
      const position = (selected === "chaser" ? absolute.chaser : absolute.target).position;
      const radius = Math.hypot(position.xKm, position.yKm, position.zKm);
      element<HTMLElement>("#state-heading").textContent = "Absolute ECI";
      element<HTMLElement>("#state-unit").textContent = "km radius";
      element<HTMLElement>("#axis-x-label").textContent = "ECI X";
      element<HTMLElement>("#axis-y-label").textContent = "ECI Y";
      element<HTMLElement>("#axis-z-label").textContent = "ECI Z";
      element<HTMLElement>("#separation").textContent = radius.toFixed(1);
      element<HTMLElement>("#radial-position").textContent = `${position.xKm.toFixed(1)} km`;
      element<HTMLElement>("#intrack-position").textContent = `${position.yKm.toFixed(1)} km`;
      element<HTMLElement>("#cross-position").textContent = `${position.zKm.toFixed(1)} km`;
      envelope.textContent = "pdb absolute source";
      envelope.classList.remove("rejected");
    }
    phaseTimeline.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.classList.toggle("passed", Number(button.dataset.time) <= state.timeSec);
    });
    requestAnimationFrame(renderFrame);
  };
  requestAnimationFrame(renderFrame);
}

start().catch((error: unknown) => {
  console.error(error);
  const app = document.querySelector<HTMLElement>("#app");
  if (app) {
    app.innerHTML = `<div class="fatal-error"><strong>Viewer failed closed</strong><span>${error instanceof Error ? error.message : String(error)}</span></div>`;
  }
});
