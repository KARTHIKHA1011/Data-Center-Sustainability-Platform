"""
Server telemetry simulator.

Generates realistic CPU / memory / network / workload readings for a fleet
of servers, standing in for a real monitoring feed (Prometheus node-exporter,
hypervisor APIs, etc.).

Demo configuration:
    S4, S5, S6 are deliberately biased toward low utilization so the
    idle-server detection rule has servers to catch during a demo.

Usage:
    python server_monitor.py
"""

import random
import time
import requests


API_BASE = "http://localhost:8000"

# ---------------------------------------------------------------------------
# Server workload profiles
# ---------------------------------------------------------------------------
#
# bias represents the approximate workload intensity:
#
#   0.65 -> high utilization
#   0.60 -> high utilization
#   0.30 -> moderate utilization
#   0.15 -> low utilization
#   0.12 -> low utilization
#   0.05 -> very low utilization
#
# S6 is deliberately very idle so that it is easy to demonstrate
# the Consolidate recommendation.
# ---------------------------------------------------------------------------

SERVERS = {
    "S1": {"bias": 0.65},
    "S2": {"bias": 0.60},
    "S3": {"bias": 0.30},
    "S4": {"bias": 0.15},   # deliberately idle
    "S5": {"bias": 0.12},   # deliberately idle
    "S6": {"bias": 0.05},   # deliberately very idle

    # Added for a richer same-type candidate pool -- GPU, Storage and Edge
    # previously had only one peer each (or none), so consolidation ranking
    # never had more than a single candidate to actually rank.
    "S7": {"bias": 0.55},   # GPU, healthy
    "S8": {"bias": 0.10},   # GPU, deliberately idle
    "S9": {"bias": 0.45},   # Storage, healthy
    "S10": {"bias": 0.14},  # Storage, deliberately idle
    "S11": {"bias": 0.50},  # Edge, healthy
    "S12": {"bias": 0.16},  # Edge, deliberately idle
    "S13": {"bias": 0.70},  # Compute, healthy
}


# Telemetry posting interval
INTERVAL_SECONDS = 15


# ---------------------------------------------------------------------------
# Generate server telemetry
# ---------------------------------------------------------------------------

def generate_reading(server_id, bias):
    """
    Generate one realistic server telemetry reading.

    The bias controls the normal workload level while random noise
    prevents every reading from being identical.
    """

    workload = max(
        0.02,
        min(
            0.98,
            random.gauss(bias, 0.08)
        )
    )

    cpu = max(
        1,
        min(
            99,
            workload * 100 + random.uniform(-5, 5)
        )
    )

    memory = max(
        5,
        min(
            99,
            cpu * 0.9 + random.uniform(-8, 8)
        )
    )

    network = max(
        0.1,
        workload * 25 + random.uniform(-2, 2)
    )

    return {
        "server_id": server_id,
        "cpu_utilization": round(cpu, 2),
        "memory_utilization": round(memory, 2),
        "network_throughput_gbps": round(network, 2),
        "workload_intensity": round(
            workload,
            3
        ),
    }


# ---------------------------------------------------------------------------
# Register servers with GreenOps
# ---------------------------------------------------------------------------

def register_servers():

    # cooling_type and datacenter_region values are deliberately restricted
    # to green_ai_datacenter.csv's actual training vocabulary --
    # cooling_type: Air/Hybrid/Liquid, datacenter_region: APAC/EU/ME. The
    # dataset has no "Evaporative"/"EMEA"/"NA" categories at all, so those
    # values (used here previously) were silently zero-encoded by
    # OneHotEncoder(handle_unknown="ignore") for every server carrying them
    # -- degrading the CPU/power validation models' live predictions with no
    # visible warning anywhere. EMEA maps to EU and NA maps to ME below;
    # neither is a precise real-world equivalent (the dataset simply has no
    # North America category), the goal is only that every value here is one
    # the trained models actually recognize instead of quietly discarding.
    meta = {
        "S1": {
            "server_type": "Compute",
            "cooling_type": "Air",
            "datacenter_region": "APAC",
        },

        "S2": {
            "server_type": "Compute",
            "cooling_type": "Air",
            "datacenter_region": "APAC",
        },

        "S3": {
            "server_type": "GPU",
            "cooling_type": "Hybrid",
            "datacenter_region": "EU",
        },

        "S4": {
            "server_type": "Storage",
            "cooling_type": "Liquid",
            "datacenter_region": "ME",
        },

        "S5": {
            "server_type": "Edge",
            "cooling_type": "Air",
            "datacenter_region": "APAC",
        },

        # -------------------------------------------------------
        # NEW DEMO SERVER
        # -------------------------------------------------------
        "S6": {
            "server_type": "Compute",
            "cooling_type": "Air",
            "datacenter_region": "APAC",
        },

        # -------------------------------------------------------
        # ADDITIONAL SERVERS -- richer same-type candidate pools
        # -------------------------------------------------------
        "S7": {
            "server_type": "GPU",
            "cooling_type": "Hybrid",
            "datacenter_region": "EU",
        },

        "S8": {
            "server_type": "GPU",
            "cooling_type": "Hybrid",
            "datacenter_region": "ME",
        },

        "S9": {
            "server_type": "Storage",
            "cooling_type": "Liquid",
            "datacenter_region": "ME",
        },

        "S10": {
            "server_type": "Storage",
            "cooling_type": "Liquid",
            "datacenter_region": "APAC",
        },

        "S11": {
            "server_type": "Edge",
            "cooling_type": "Air",
            "datacenter_region": "APAC",
        },

        "S12": {
            "server_type": "Edge",
            "cooling_type": "Air",
            "datacenter_region": "EU",
        },

        "S13": {
            "server_type": "Compute",
            "cooling_type": "Air",
            "datacenter_region": "ME",
        },
    }

    for server_id, metadata in meta.items():

        payload = {
            "server_id": server_id,
            **metadata,
        }

        try:

            response = requests.post(
                f"{API_BASE}/servers/register",
                json=payload,
                timeout=5,
            )

            if response.status_code != 200:
                print(
                    f"[register] {server_id} -> "
                    f"{response.status_code} "
                    f"{response.text}"
                )
            else:
                print(
                    f"[register] {server_id} -> "
                    f"{response.json()}"
                )

        except requests.exceptions.ConnectionError:

            print(
                "Backend not reachable yet -- "
                "start the FastAPI server first."
            )

            raise


# ---------------------------------------------------------------------------
# Main simulator loop
# ---------------------------------------------------------------------------

def main():

    print("=" * 60)
    print("GreenOps Server Telemetry Simulator")
    print("=" * 60)

    print("\nRegistering servers...")
    register_servers()

    print("\nServers being simulated:")

    for server_id, config in SERVERS.items():

        print(
            f"  {server_id} -> "
            f"workload bias = {config['bias']}"
        )

    print(
        f"\nPosting telemetry every "
        f"{INTERVAL_SECONDS} seconds."
    )

    print(
        "S6 is deliberately configured as a "
        "very-low-utilization server."
    )

    print("\nPress Ctrl+C to stop.\n")

    # -------------------------------------------------------
    # Continuous telemetry generation
    # -------------------------------------------------------

    while True:

        for server_id, config in SERVERS.items():

            reading = generate_reading(
                server_id,
                config["bias"],
            )

            try:

                response = requests.post(
                    f"{API_BASE}/telemetry/server",
                    json=reading,
                    timeout=5,
                )

                if response.status_code != 200:

                    print(
                        f"[server] {server_id} -> "
                        f"{response.status_code} "
                        f"{response.text}"
                    )

                else:

                    print(
                        f"[server] {server_id} -> "
                        f"CPU {reading['cpu_utilization']:>5.1f}% | "
                        f"Memory {reading['memory_utilization']:>5.1f}% | "
                        f"Workload {reading['workload_intensity']:.3f}"
                    )

            except requests.exceptions.ConnectionError:

                print(
                    "[server] Backend not reachable, "
                    "retrying next cycle..."
                )

        time.sleep(INTERVAL_SECONDS)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    main()