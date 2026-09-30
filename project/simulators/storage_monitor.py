"""
Storage telemetry simulator.

Generates capacity, staleness, and duplication metrics per server,
standing in for filesystem metadata APIs / storage array management
tools / cloud storage APIs.

This simulator provides METADATA only:
    - storage capacity
    - used storage
    - last-accessed age
    - duplicate-data volume

Demo scenarios:
    S3 -> Rightsize
    S4 -> Archive
    S6 -> Consolidate is handled by server + power telemetry,
          so S6 does NOT need storage optimization data.

Usage:
    python storage_monitor.py
"""

import random
import time
import requests


API_BASE = "http://localhost:8000"


# ---------------------------------------------------------------------------
# Storage configuration
# ---------------------------------------------------------------------------
#
# Format:
#
# server_id:
# (
#     total_gb,
#     used_ratio_range,
#     stale_days_range,
#     duplicate_ratio_range,
#     storage_type
# )
#
# S3 -> deliberately underutilized storage
# S4 -> deliberately stale storage
#
# S1, S2, S5 -> normal storage
# ---------------------------------------------------------------------------

SERVERS = {

    "S1": (
        1000,
        (0.55, 0.75),
        (1, 30),
        (0.02, 0.10),
        "SSD",
    ),

    "S2": (
        1000,
        (0.50, 0.70),
        (1, 40),
        (0.02, 0.10),
        "SSD",
    ),

    # -------------------------------------------------------
    # RIGHTSIZING DEMO
    # -------------------------------------------------------
    #
    # Only 20-35% of the allocated storage is being used.
    # This can trigger:
    #
    #     used / total < 30%
    #
    # -> Rightsize recommendation
    #
    "S3": (
        2000,
        (0.20, 0.25),
        (60, 80),
        (0.05, 0.15),
        "HDD",
    ),

    # -------------------------------------------------------
    # ARCHIVE DEMO
    # -------------------------------------------------------
    #
    # Data has not been accessed for 100-250 days.
    # Your rule uses:
    #
    #     STALE_DATA_DAYS = 90
    #
    # -> Archive recommendation
    #
    "S4": (
        500,
        (0.60, 0.80),
        (100, 250),
        (0.05, 0.15),
        "Object",
    ),

    # -------------------------------------------------------
    # NORMAL STORAGE
    # -------------------------------------------------------

    "S5": (
        500,
        (0.45, 0.65),
        (5, 20),
        (0.02, 0.08),
        "SSD",
    ),

    # -------------------------------------------------------
    # ADDITIONAL SERVERS -- normal storage profiles, same shape
    # as S1/S2/S5. S6 is deliberately excluded from this file
    # (see module docstring); S7-S13 are not, since a real idle
    # server would still have ordinary storage.
    # -------------------------------------------------------

    "S7": (
        1200,
        (0.55, 0.75),
        (5, 25),
        (0.02, 0.10),
        "SSD",
    ),

    "S8": (
        1200,
        (0.50, 0.70),
        (5, 30),
        (0.02, 0.10),
        "SSD",
    ),

    "S9": (
        800,
        (0.45, 0.65),
        (10, 30),
        (0.03, 0.10),
        "SSD",
    ),

    "S10": (
        800,
        (0.40, 0.60),
        (10, 35),
        (0.03, 0.10),
        "SSD",
    ),

    "S11": (
        400,
        (0.45, 0.65),
        (5, 20),
        (0.02, 0.08),
        "SSD",
    ),

    "S12": (
        400,
        (0.40, 0.60),
        (5, 25),
        (0.02, 0.08),
        "SSD",
    ),

    "S13": (
        1200,
        (0.55, 0.75),
        (5, 25),
        (0.02, 0.10),
        "SSD",
    ),
}


INTERVAL_SECONDS = 30


# ---------------------------------------------------------------------------
# Generate storage telemetry
# ---------------------------------------------------------------------------

def generate_reading(
    server_id,
    total_gb,
    used_range,
    stale_range,
    dup_range,
    storage_type,
):

    used_gb = round(
        total_gb * random.uniform(*used_range),
        2,
    )

    duplicate_gb = round(
        total_gb * random.uniform(*dup_range),
        2,
    )

    last_accessed_days = random.randint(
        *stale_range
    )

    return {
        "server_id": server_id,

        "total_storage_gb": total_gb,

        "used_storage_gb": used_gb,

        "duplicate_data_gb": duplicate_gb,

        "last_accessed_days_ago": last_accessed_days,

        "storage_type": storage_type,
    }


# ---------------------------------------------------------------------------
# Main simulator
# ---------------------------------------------------------------------------

def main():

    print("=" * 60)
    print("GreenOps Storage Telemetry Simulator")
    print("=" * 60)

    print(
        f"\nStorage monitor running."
        f" Posting every {INTERVAL_SECONDS}s."
    )

    print("\nStorage scenarios:")

    print("  S1 -> Normal")
    print("  S2 -> Normal")
    print("  S3 -> Rightsize candidate")
    print("  S4 -> Archive candidate")
    print("  S5 -> Normal")

    print(
        "\nS6 does not need storage telemetry "
        "because it is used for the Consolidate demo."
    )

    print("\nPress Ctrl+C to stop.\n")

    while True:

        for sid, cfg in SERVERS.items():

            reading = generate_reading(
                sid,
                *cfg,
            )

            try:

                response = requests.post(
                    f"{API_BASE}/telemetry/storage",
                    json=reading,
                    timeout=5,
                )

                if response.status_code != 200:

                    print(
                        f"[storage] {sid} -> "
                        f"{response.status_code} "
                        f"{response.text}"
                    )

                else:

                    utilization = (
                        reading["used_storage_gb"]
                        / reading["total_storage_gb"]
                    ) * 100

                    print(
                        f"[storage] {sid} -> "
                        f"Used {utilization:.1f}% | "
                        f"Stale {reading['last_accessed_days_ago']} days | "
                        f"Duplicate "
                        f"{reading['duplicate_data_gb']:.1f} GB"
                    )

            except requests.exceptions.ConnectionError:

                print(
                    "[storage] Backend not reachable, "
                    "retrying next cycle..."
                )

        time.sleep(INTERVAL_SECONDS)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    main()