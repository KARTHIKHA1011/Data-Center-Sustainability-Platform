
"""
Computes per-server-type idle CPU thresholds and severity weights from the
real historical dataset, replacing the old flat 20%-for-everyone threshold.

Rationale (see project discussion): a single global CPU cutoff ignores that
different server types have different normal operating ranges, and that the
COST of being idle differs by type (a GPU server sitting idle wastes far more
power than an Edge server at the same CPU%, since GPU hardware draws ~40%
more power on average per the dataset).

Method:
  threshold(type) = mean_cpu(type) - 1.5 * std_cpu(type)
  clamped to [5, 35] so no type's threshold becomes physically nonsensical

  severity_weight(type) = avg_power_kw(type) / min(avg_power_kw across types)
  -- a multiplier used to prioritize which idle flags matter more.

Run:
    python -m app.compute_thresholds
"""
import json
import os
import pandas as pd

APP_DIR = os.path.dirname(__file__)
DATA_PATH = os.path.join(APP_DIR, "data", "green_ai_datacenter.csv")
OUT_PATH = os.path.join(APP_DIR, "data", "type_thresholds.json")

MIN_THRESHOLD = 5.0
MAX_THRESHOLD = 35.0
STD_MULTIPLIER = 1.5


def main():
    df = pd.read_csv(DATA_PATH)

    stats = df.groupby("server_type").agg(
        cpu_mean=("cpu_utilization", "mean"),
        cpu_std=("cpu_utilization", "std"),
        avg_power_kw=("power_consumption_kw", "mean"),
        sample_count=("cpu_utilization", "count"),
    )

    min_power = stats["avg_power_kw"].min()

    table = {}
    for server_type, row in stats.iterrows():
        raw_threshold = row["cpu_mean"] - STD_MULTIPLIER * row["cpu_std"]
        threshold = max(MIN_THRESHOLD, min(MAX_THRESHOLD, raw_threshold))
        severity_weight = round(row["avg_power_kw"] / min_power, 2)

        table[server_type] = {
            "idle_cpu_threshold": round(threshold, 1),
            "dataset_cpu_mean": round(row["cpu_mean"], 2),
            "dataset_cpu_std": round(row["cpu_std"], 2),
            "avg_power_kw": round(row["avg_power_kw"], 2),
            "severity_weight": severity_weight,
            "sample_count": int(row["sample_count"]),
        }
        print(
            f"{server_type:10s}  threshold={threshold:5.1f}%   "
            f"(mean={row['cpu_mean']:.1f}, std={row['cpu_std']:.1f})   "
            f"avg_power={row['avg_power_kw']:.1f}kW   severity_weight={severity_weight}x"
        )

    # fallback used for any server_type not present in the historical dataset
    table["_default"] = {
        "idle_cpu_threshold": 20.0,
        "dataset_cpu_mean": None,
        "dataset_cpu_std": None,
        "avg_power_kw": None,
        "severity_weight": 1.0,
        "sample_count": 0,
        "note": "fallback for a server_type not seen in the historical dataset",
    }

    with open(OUT_PATH, "w") as f:
        json.dump(table, f, indent=2)

    print(f"\nSaved per-type thresholds to {OUT_PATH}")


if __name__ == "__main__":
    main()
