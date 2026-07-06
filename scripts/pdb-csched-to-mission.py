#!/usr/bin/env python3
# Copyright 2026 nicanadian. Apache-2.0.
#
# Export a csched-planned mission for the dv.gl demo: real tasked COLLECTS plus a
# fleet ephemeris, both generated from ONE csched run over the same fleet + epoch
# so a collect window always falls on its satellite's ground track.
#
# Emits two files next to the bench-runner (both gitignored, like mission.oem):
#   mission.oem           -- CCSDS OEM v2 (KVN), one segment per satellite
#   mission.collects.json -- [{sat, start, end, targetLat, targetLon, look, sensor, gsd}]
#
# A collect is scheduler output: an Opportunity (satellite_id + window + look angle,
# from schedule_*.json) joined to its Request (target lat/lon, from deck.json) on
# request_id. The sim does NOT emit a ground footprint polygon -- only a target
# point + look angle -- so dv.gl computes the footprint box itself.
#
# Run from the pdb-spacecraft-simulator repo root with its venv:
#   cd ~/repos/pdb-spacecraft-simulator
#   .venv/bin/python ~/repos/dv.gl/scripts/pdb-csched-to-mission.py \
#       --out ~/repos/dv.gl/apps/bench-runner
import argparse
import json
from datetime import timedelta, timezone
from pathlib import Path


def iso_z(dt) -> str:
    # force true UTC (a bare .astimezone() would silently convert to local time)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fleet", default="configs/csched/fleet_12sar12eo.json")
    ap.add_argument("--stations", default="configs/csched/stations_full.json")
    ap.add_argument("--seed", type=int, default=11001)
    ap.add_argument("--size", type=int, default=140)
    ap.add_argument("--horizon-hours", type=float, default=24.0)
    ap.add_argument("--out", required=True, help="dir for mission.oem + mission.collects.json")
    args = ap.parse_args()

    from csched.fleet import (
        generate_fleet_ephemerides,
        load_fleet_config,
        load_station_inventory,
    )
    from csched.run import EPOCH, run_csched01

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # 1) run the scheduler pipeline -> deck.json + schedule_greedy.json
    run_root = run_csched01(
        seed=args.seed,
        size=args.size,
        out_root="/tmp/dvgl_csched",
        fleet_path=args.fleet,
        stations_path=args.stations,
        horizon_hours=args.horizon_hours,
        validate=False,
    )
    run_root = Path(run_root)
    schedule = json.loads((run_root / "schedule_greedy.json").read_text())
    deck = json.loads((run_root / "deck.json").read_text())
    targets = {r["request_id"]: r for r in deck["requests"]}

    # ground footprint dimensions per collect (the sim gives target + look angle, not
    # a polygon, so size the box from the sensor model): EO frame swath = GSD x the
    # cross-track detector count (sensors_realistic EO = 12000 px), ~square scene;
    # SAR = a side-looking stripmap swath (catalog lacks a clean swath number).
    EO_DETECTOR_PX = 12000

    def footprint_km(sensor, gsd_m):
        if (sensor or "").upper().startswith("SAR"):
            return 24.0, 60.0  # cross, along (elongated strip)
        sw = min(80.0, (gsd_m or 5.0) * EO_DETECTOR_PX / 1000.0)
        return sw, sw

    # 2) join scheduled opportunities to their request targets -> collects
    collects = []
    for op in schedule.get("scheduled", []):
        req = targets.get(op["request_id"])
        if req is None:
            continue
        # sensor = the SATELLITE's sensor (SAR-xx / EO-xx), not the request's desired
        # sensor_type (which the scheduler may satisfy with either bus in this fleet).
        sat = op["satellite_id"]
        sensor = "SAR" if sat.upper().startswith("SAR") else "EO"
        cross_km, along_km = footprint_km(sensor, op.get("best_gsd_m"))
        collects.append(
            {
                "id": op["opportunity_id"],
                "sat": sat,
                "requestId": op["request_id"],
                "start": op["window_start"],
                "end": op["window_end"],
                "targetLatDeg": req["target_lat_deg"],
                "targetLonDeg": req["target_lon_deg"],
                "lookAngleDeg": op.get("look_angle_deg"),
                "sensor": sensor,
                "gsdM": op.get("best_gsd_m"),
                "priority": op.get("priority"),
                "crossKm": round(cross_km, 2),
                "alongKm": round(along_km, 2),
            }
        )
    collects.sort(key=lambda c: c["start"])

    (out / "mission.collects.json").write_text(
        json.dumps(
            {"epoch": iso_z(EPOCH), "horizonHours": args.horizon_hours, "collects": collects},
            indent=1,
        )
    )

    # 3) regenerate the same fleet's ephemeris at the SAME epoch -> OEM segments
    sats = load_fleet_config(args.fleet)
    stations = load_station_inventory(args.stations)
    ephem = generate_fleet_ephemerides(
        sats, stations, EPOCH, horizon=timedelta(hours=args.horizon_hours)
    )
    lines = ["CCSDS_OEM_VERS = 2.0", "CREATION_DATE = " + iso_z(EPOCH), "ORIGINATOR = dv.gl"]
    for sat in sats:
        pe = ephem[sat.satellite_id]
        pts = pe.ephemeris
        lines += [
            "META_START",
            f"OBJECT_NAME = {sat.satellite_id}",
            f"OBJECT_ID = {sat.satellite_id}",
            "CENTER_NAME = EARTH",
            "REF_FRAME = EME2000",
            "COMMENT frame is the csched planning ECI axis set (LOW fidelity)",
            "TIME_SYSTEM = UTC",
            f"START_TIME = {iso_z(pts[0].time)}",
            f"STOP_TIME = {iso_z(pts[-1].time)}",
            "META_STOP",
        ]
        for p in pts:
            x, y, z = p.position_eci
            lines.append(f"{iso_z(p.time)} {x:.6f} {y:.6f} {z:.6f}")
    (out / "mission.oem").write_text("\n".join(lines) + "\n")

    print(f"wrote {len(collects)} collects across "
          f"{len({c['sat'] for c in collects})} sats + {len(sats)}-sat OEM to {out}")


if __name__ == "__main__":
    main()
