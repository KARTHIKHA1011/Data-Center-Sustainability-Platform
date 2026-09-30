"""
Power telemetry simulator.

Generates IT power and facility power readings per server, standing in for
smart PDUs / UPS management interfaces / BMS power meters.

Facility power = IT power + cooling overhead + UPS/other losses.

IT power is generated as a function of the server's OWN current CPU and
memory utilization (baseline idle draw + a load-scaled component + small
noise) -- it deliberately reads each server's latest telemetry from the
backend before generating a reading. Earlier this simply drew a random
number with no relationship to load at all, which meant no ML model could
ever legitimately learn or apply a CPU/memory -> power relationship against
this simulator's own output. S6 no longer needs a special-cased low-power
branch: since server_monitor.py already gives it a very low workload bias,
its power now naturally comes out low too, for the same reason a real idle
server would draw less power.

The facility overhead ratio (IT power -> facility power, i.e. what PUE
actually measures) is likewise generated from the server's current
cooling_efficiency (also fetched from GET /servers, posted by
cooling_monitor.py) instead of a pure random draw -- worse cooling
efficiency now means worse (higher) overhead, the same real relationship
PUE is supposed to reflect. This was the one gap left in the original power
fix: it_power_kw responded to load, but PUE still didn't respond to
anything, so it stayed exactly as uninformative to the CPU/power validation
models as before that fix.

Usage:
    python power_monitor.py
"""

import random
import time
import requests


API_BASE = "http://localhost:8000"

# S6 added; S7-S13 added for a richer same-type candidate pool
SERVER_IDS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13"]

INTERVAL_SECONDS = 15

# IT power model: baseline (idle) draw + a load-scaled variable component.
# Chosen so the overall range matches what this simulator always produced
# (roughly 1.2-4.5 kW) -- only the internal relationship to load is new.
BASELINE_IT_KW = 1.2
MAX_VARIABLE_IT_KW = 3.3
CPU_WEIGHT = 0.85
MEMORY_WEIGHT = 0.15
NOISE_KW = 0.15

# Used only when a server's live CPU/memory can't be fetched yet (e.g. the
# very first cycle, before server_monitor.py has posted anything for it).
FALLBACK_CPU_PERCENT = 20.0
FALLBACK_MEMORY_PERCENT = 20.0
FALLBACK_COOLING_EFFICIENCY = 0.82

# Facility overhead (IT power -> facility power -> PUE). Base is the
# best-case overhead at near-perfect cooling efficiency; the penalty scales
# up linearly as efficiency drops toward its worst observed floor (0.4, see
# cooling_monitor.py). Chosen so the overall PUE range matches what this
# simulator always produced (roughly 1.15-1.55) -- only the relationship to
# cooling is new.
BASE_OVERHEAD_RATIO = 1.15
MAX_OVERHEAD_PENALTY = 0.40
OVERHEAD_NOISE = 0.03
WORST_COOLING_EFFICIENCY = 0.4
BEST_COOLING_EFFICIENCY = 0.99


def get_current_load():
    """
    Fetch each server's latest CPU/memory from the backend so IT power can
    respond to real load instead of being independent random noise.
    """

    try:
        response = requests.get(f"{API_BASE}/servers", timeout=5)
        if response.status_code == 200:
            return {s["server_id"]: s for s in response.json()}
    except requests.exceptions.RequestException:
        pass

    return {}


def generate_reading(server_id, cpu, memory, cooling_efficiency):
    """
    Generate IT and facility power for one server, given its current
    CPU/memory utilization and cooling efficiency.
    """

    cpu = FALLBACK_CPU_PERCENT if cpu is None else cpu
    memory = FALLBACK_MEMORY_PERCENT if memory is None else memory
    cooling_efficiency = (
        FALLBACK_COOLING_EFFICIENCY if cooling_efficiency is None else cooling_efficiency
    )

    cpu_fraction = max(0.0, min(1.0, cpu / 100.0))
    memory_fraction = max(0.0, min(1.0, memory / 100.0))

    variable_kw = MAX_VARIABLE_IT_KW * (
        CPU_WEIGHT * cpu_fraction + MEMORY_WEIGHT * memory_fraction
    )

    it_power = round(
        max(
            0.3,
            BASELINE_IT_KW + variable_kw + random.uniform(-NOISE_KW, NOISE_KW),
        ),
        2,
    )

    # Facility overhead factor -> PUE. Worse cooling efficiency pushes this
    # up (more overhead per unit of IT power delivered), not a random draw.
    efficiency = max(WORST_COOLING_EFFICIENCY, min(BEST_COOLING_EFFICIENCY, cooling_efficiency))
    penalty_fraction = (BEST_COOLING_EFFICIENCY - efficiency) / (BEST_COOLING_EFFICIENCY - WORST_COOLING_EFFICIENCY)
    overhead_ratio = max(
        1.05,
        BASE_OVERHEAD_RATIO + MAX_OVERHEAD_PENALTY * penalty_fraction + random.uniform(-OVERHEAD_NOISE, OVERHEAD_NOISE),
    )

    facility_power = round(
        it_power * overhead_ratio,
        2
    )

    return {
        "server_id": server_id,
        "it_power_kw": it_power,
        "facility_power_kw": facility_power,
    }


def main():

    print("=" * 60)
    print("GreenOps Power Telemetry Simulator")
    print("=" * 60)

    print(
        f"\nPower monitor running."
        f" Posting every {INTERVAL_SECONDS}s."
    )

    print(
        "Servers:",
        ", ".join(SERVER_IDS)
    )

    print(
        "\nS6 is configured as the low-utilization "
        "consolidation demo server."
    )

    print("\nPress Ctrl+C to stop.\n")

    while True:

        current_load = get_current_load()

        for sid in SERVER_IDS:

            server_info = current_load.get(sid, {})

            reading = generate_reading(
                sid,
                server_info.get("cpu"),
                server_info.get("memory"),
                server_info.get("cooling_efficiency"),
            )

            try:

                response = requests.post(
                    f"{API_BASE}/telemetry/power",
                    json=reading,
                    timeout=5,
                )

                if response.status_code != 200:

                    print(
                        f"[power] {sid} -> "
                        f"{response.status_code} "
                        f"{response.text}"
                    )

                else:

                    print(
                        f"[power] {sid} -> "
                        f"IT {reading['it_power_kw']:.2f} kW | "
                        f"Facility {reading['facility_power_kw']:.2f} kW"
                    )

            except requests.exceptions.ConnectionError:

                print(
                    "[power] Backend not reachable, "
                    "retrying next cycle..."
                )

        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    main()