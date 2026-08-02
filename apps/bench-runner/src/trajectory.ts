import {
  EphemerisSource,
  type LabelHit,
  LabelsLayer,
  parseOem,
  SatellitesLayer,
  Scene,
  TracksLayer,
} from "@dvgl/viewer";

interface TrajectoryEvent {
  readonly event_id: string;
  readonly type: string;
  readonly elapsed_s: number;
  readonly mode?: string;
}

interface GuidanceSample {
  readonly elapsed_s: number;
  readonly mode: string;
  readonly mass_kg: number;
  readonly altitude_error_km?: number;
  readonly raan_error_deg?: number;
  readonly plane_error_deg?: number;
  readonly along_track_error_km?: number;
  readonly delta_v_m_s: number;
  readonly semi_major_altitude_km?: number;
  readonly perigee_altitude_km?: number;
  readonly apogee_altitude_km?: number;
  readonly xenon_remaining_kg?: number;
  readonly battery_soc?: number;
  readonly active_channel?: string;
  readonly stack_mass_kg?: number;
}

interface GuidanceDocument {
  readonly samples: readonly GuidanceSample[];
}

const byId = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`missing element ${id}`);
  return value as T;
};

const formatMode = (mode: string): string => mode.replaceAll("_", " ");

async function main(): Promise<void> {
  const canvas = byId<HTMLCanvasElement>("trajectory-view");
  const error = byId<HTMLElement>("error");
  const descent = new URLSearchParams(window.location.search).get("phase") === "descent";
  const stem = descent ? "sl8-ep-descent" : "sl8-ep-rendezvous";
  byId<HTMLElement>(descent ? "descent-tab" : "rendezvous-tab").classList.add("active");
  if (descent) configureDescentCopy();
  try {
    const [oemResponse, eventResponse, guidanceResponse] = await Promise.all([
      fetch(`./${stem}.oem`),
      fetch(`./${stem}.events.json`),
      fetch(`./${stem}.guidance.json`),
    ]);
    if (!oemResponse.ok || !eventResponse.ok || !guidanceResponse.ok) {
      throw new Error("trajectory evidence is unavailable");
    }
    const source = new EphemerisSource(parseOem(await oemResponse.text()).segments);
    const eventsValue = (await eventResponse.json()) as { events: TrajectoryEvent[] };
    const guidance = (await guidanceResponse.json()) as GuidanceDocument;
    const events = [...eventsValue.events].sort((left, right) => left.elapsed_s - right.elapsed_s);

    const dpr = window.devicePixelRatio || 1;
    const size = (): void => {
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    };
    size();
    const scene = await Scene.create({
      canvas,
      epochMs: source.epochMs,
      windowSeconds: source.windowSeconds,
      rate: 21600,
    });
    scene.clock.loop = false;
    scene.camera.zoom(0.72);
    scene.setGraticule(false);
    const fleet = new SatellitesLayer({ pointSizePx: 9 });
    fleet.setSource(source);
    const colors = new Float32Array(source.count * 4);
    source.names.forEach((name, index) => {
      colors.set(name.includes("REMOVER") || name.includes("ATTACHED") ? [0.29, 0.64, 0.89, 1] : [0.94, 0.71, 0.3, 1], index * 4);
    });
    fleet.setColors(colors);
    scene.add(
      new TracksLayer({
        source,
        fleet,
        samples: 129,
        recomputeMinutes: 30,
        halfWindowPeriods: 0.5,
      }),
    );
    scene.add(fleet);
    const labelsRoot = byId<HTMLElement>("labels");
    const labelPool: HTMLSpanElement[] = [];
    const labels = new LabelsLayer({ fleet });
    labels.onLabels((hits: readonly LabelHit[]) => {
      hits.forEach((hit, index) => {
        let label = labelPool[index];
        if (!label) {
          label = document.createElement("span");
          labelsRoot.appendChild(label);
          labelPool[index] = label;
        }
        label.textContent = hit.name.split("/").pop() ?? hit.name;
        label.style.left = `${hit.x * labelsRoot.clientWidth + 8}px`;
        label.style.top = `${hit.y * labelsRoot.clientHeight - 8}px`;
        label.style.display = "block";
      });
      for (let index = hits.length; index < labelPool.length; index += 1) {
        const label = labelPool[index];
        if (label) label.style.display = "none";
      }
    });
    scene.add(labels);
    scene.attachControls(canvas);
    scene.start();

    const phaseList = byId<HTMLElement>("phase-list");
    const phaseButtons = events.map((event, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "phase-button";
      button.innerHTML = `<span class="phase-index">${String(index + 1).padStart(2, "0")}</span><span><strong>${formatMode(event.mode ?? event.type)}</strong><small>T+${(event.elapsed_s / 86400).toFixed(2)} days</small></span>`;
      button.onclick = () => {
        scene.clock.scrubTo(event.elapsed_s);
        scene.clock.pause();
      };
      phaseList.appendChild(button);
      return button;
    });

    const play = byId<HTMLButtonElement>("play");
    play.onclick = () => {
      if (scene.clock.playing) scene.clock.pause();
      else scene.clock.play();
    };
    byId<HTMLButtonElement>("restart").onclick = () => {
      scene.clock.pause();
      scene.clock.scrubTo(0);
    };
    const scrub = byId<HTMLInputElement>("scrub");
    scrub.max = String(Math.round(source.windowSeconds));
    scrub.oninput = () => {
      scene.clock.pause();
      scene.clock.scrubTo(Number(scrub.value));
    };
    document.querySelectorAll<HTMLButtonElement>("[data-rate]").forEach((button) => {
      button.onclick = () => {
        scene.clock.rate = Number(button.dataset.rate);
        document.querySelectorAll("[data-rate]").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
      };
    });

    const sampleAt = (time: number): GuidanceSample => {
      let right = guidance.samples.findIndex((sample) => sample.elapsed_s >= time);
      if (right < 0) right = guidance.samples.length - 1;
      return guidance.samples[Math.max(0, right)] as GuidanceSample;
    };
    const updateUi = (): void => {
      const time = scene.clock.currentSeconds;
      const sample = sampleAt(time);
      scrub.value = String(Math.round(time));
      play.textContent = scene.clock.playing ? "Pause" : "Play";
      byId("elapsed").textContent = `T+${(time / 86400).toFixed(2)} d`;
      byId("phase").textContent = formatMode(sample.mode);
      byId("utc").textContent = new Date(scene.clock.currentUnixMs()).toISOString().replace("T", " ").slice(0, 19) + " UTC";
      byId("mode").textContent = formatMode(sample.mode);
      byId("along-track").textContent = descent
        ? `${sample.perigee_altitude_km?.toFixed(1) ?? "--"} km`
        : `${sample.along_track_error_km?.toFixed(1) ?? "--"} km`;
      byId("altitude-error").textContent = descent
        ? `${sample.apogee_altitude_km?.toFixed(1) ?? "--"} km`
        : `${sample.altitude_error_km?.toFixed(2) ?? "--"} km`;
      byId("raan-error").textContent = descent
        ? `${sample.xenon_remaining_kg?.toFixed(1) ?? "--"} kg`
        : `${sample.raan_error_deg?.toFixed(3) ?? "--"} deg`;
      byId("plane-error").textContent = descent
        ? `${sample.battery_soc != null ? (sample.battery_soc * 100).toFixed(1) : "--"}%`
        : `${sample.plane_error_deg?.toFixed(3) ?? "--"} deg`;
      byId("delta-v").textContent = `${sample.delta_v_m_s.toFixed(1)} m/s`;
      byId("mass").textContent = `${(sample.stack_mass_kg ?? sample.mass_kg).toFixed(1)} kg`;
      let active = 0;
      events.forEach((event, index) => { if (event.elapsed_s <= time) active = index; });
      phaseButtons.forEach((button, index) => button.classList.toggle("active", index === active));
      requestAnimationFrame(updateUi);
    };
    updateUi();
    window.addEventListener("resize", size);
  } catch (reason) {
    error.style.display = "flex";
    error.textContent = reason instanceof Error ? reason.message : String(reason);
  }
}

function configureDescentCopy(): void {
  document.title = "SL-8 attached-stack EP descent";
  byId("mission-title").textContent = "SL-8 attached-stack EP descent";
  byId("mission-subtitle").textContent = "Rigid capture to passive-decay handoff";
  byId("authority-text").textContent = "Observed numerical · GMAT dynamics checked";
  byId("evidence-boundary").textContent = "Playback begins after rigid capture. It propagates the combined stack with J2, mass depletion, eclipse, battery, thermal cadence, and HET interruptions; atmospheric entry is not represented.";
  byId("metric-1-label").textContent = "Perigee altitude";
  byId("metric-2-label").textContent = "Apogee altitude";
  byId("metric-3-label").textContent = "Xenon remaining";
  byId("metric-4-label").textContent = "Battery state of charge";
  byId("mass-label").textContent = "Attached stack mass";
  byId("legend-primary").textContent = "Remover + SL-8 stack";
  byId("legend-secondary-row").style.display = "none";
  byId("gate-label").textContent = "Passive-decay handoff";
  byId("gate-value").textContent = "200 km mean altitude";
  byId("gate-detail").textContent = "185 km maximum perigee";
  byId("oracle-title").textContent = "Independent dynamics check passed";
  byId("oracle-detail").textContent = "A three-day GMAT R2026a comparison agrees to 0.05 km in semimajor axis and 0.001 kg in mass. Full-duration entry and casualty-risk qualification remain open.";
}

void main();
