# Copyright 2026 nicanadian
# Licensed under the Apache License, Version 2.0.
#
# Export pdb-spacecraft-simulator run ephemerides as a CCSDS OEM v2 (KVN) file --
# the dogfood bridge: any sim run (single sat or fleet) becomes a dv.gl scene.
#
# Usage:
#   python pdb-run-to-oem.py OUT.oem RUN_DIR [RUN_DIR ...]
#
# Each (run, sat_id) pair becomes one OEM segment. Positions are read from
# ephemeris.parquet (x_km/y_km/z_km, sim ECI frame -> recorded as EME2000 with a
# provenance comment). Requires pandas+pyarrow (use the pdb repo's venv).
import sys
from pathlib import Path

import pandas as pd


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit("usage: pdb-run-to-oem.py OUT.oem RUN_DIR [RUN_DIR ...]")
    out_path = Path(sys.argv[1])
    lines = [
        "CCSDS_OEM_VERS = 2.0",
        "CREATION_DATE = 2026-07-04T00:00:00",
        "ORIGINATOR = pdb-spacecraft-simulator",
        "",
    ]
    n_segments = 0
    for run_dir in sys.argv[2:]:
        run = Path(run_dir)
        eph = run / "ephemeris.parquet"
        if not eph.exists():
            sys.exit(f"{run}: no ephemeris.parquet")
        df = pd.read_parquet(eph)
        for sat_id, g in df.groupby("sat_id", sort=True):
            g = g.sort_values("time")
            name = f"{run.name.split('_')[0]}/{sat_id}"
            lines += [
                "META_START",
                f"OBJECT_NAME = {name}",
                f"OBJECT_ID = {sat_id}",
                "CENTER_NAME = EARTH",
                "REF_FRAME = EME2000",
                "COMMENT frame is the pdb sim ECI axis set",
                "TIME_SYSTEM = UTC",
                f"START_TIME = {iso(g['time'].iloc[0])}",
                f"STOP_TIME = {iso(g['time'].iloc[-1])}",
                "META_STOP",
            ]
            for _, row in g.iterrows():
                lines.append(
                    f"{iso(row['time'])} {row['x_km']:.6f} {row['y_km']:.6f} {row['z_km']:.6f}"
                )
            lines.append("")
            n_segments += 1
    out_path.write_text("\n".join(lines))
    print(f"wrote {n_segments} segments to {out_path}")


def iso(t: pd.Timestamp) -> str:
    return t.tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


if __name__ == "__main__":
    main()
