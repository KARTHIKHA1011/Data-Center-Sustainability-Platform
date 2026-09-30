"""
Cooling telemetry simulator.

Generates inlet temperature and cooling efficiency readings, standing in
for CRAC/chiller controllers and BMS environmental sensors.

Inlet temperature and cooling efficiency are generated as a function of the
server's OWN current CPU utilization (baseline idle reading + a load-scaled
component + small noise, per cooling_type) -- it deliberately reads each
server's latest telemetry from the backend before generating a reading, the
same fetch-then-generate pattern power_monitor.py already uses for IT power.
Earlier this drew independent random numbers with no relationship to load at
all, which meant the CPU/power validation models' `inlet_temperature_c` and
`cooling_efficiency` inputs were pure noise on live data regardless of how
good the models themselves were -- see CLAUDE.md's "Phase 2" section for the
full history of that problem and why it was worth fixing.

Different cooling_type values respond differently, on purpose: Air (weakest
cooling) shows the largest temperature rise and efficiency drop under load,
Liquid (strongest) the smallest, Hybrid in between -- a flat, identical
response for every cooling type would have been a worse simplification than
the noise it replaced.

Usage:
    python cooling_monitor.py
"""

import random
import time
import requests


API_BASE = "http://localhost:8000"

# Baseline reading at ~idle (low CPU), before any load-scaled rise is added.
BASE_TEMPERATURE_C = 19.0
BASE_EFFICIENCY = 0.95

# Max additional inlet temperature (°C) and max efficiency drop at 100% CPU,
# per cooling_type -- Air responds most, Liquid least. Values are a stated
# convention (the relative ordering is what matters -- Air worse than
# Hybrid worse than Liquid -- not the exact degrees), same spirit as the
# idle-threshold clamp: a reasonable choice, not derived from a dataset.
COOLING_TEMP_RISE_C = {"Air": 9.0, "Hybrid": 5.0, "Liquid": 2.5}
COOLING_EFFICIENCY_DROP = {"Air": 0.35, "Hybrid": 0.20, "Liquid": 0.10}

TEMPERATURE_NOISE_C = 0.8
EFFICIENCY_NOISE = 0.03

# Used only when a server's live CPU can't be fetched yet (e.g. the very
# first cycle, before server_monitor.py has posted anything for it) --
# same fallback pattern power_monitor.py uses.
FALLBACK_CPU_PERCENT = 20.0


# ---------------------------------------------------------------------------
# Cooling configuration for each server
# ---------------------------------------------------------------------------

# "Hybrid" here (not "Evaporative") deliberately matches the ML training
# dataset's cooling_type vocabulary exactly (green_ai_datacenter.csv has
# only Air/Hybrid/Liquid). "Evaporative" doesn't exist in that vocabulary,
# so OneHotEncoder(handle_unknown="ignore") was silently zero-encoding it
# for every server using it -- degrading both the CPU and power validation
# models' live predictions for those servers without any visible warning.
SERVER_COOLING = {
    "S1": "Air",
    "S2": "Air",
    "S3": "Hybrid",
    "S4": "Liquid",
    "S5": "Air",

    # S6 added
    "S6": "Air",

    # S7-S13 added -- must match server_monitor.py's register_servers()
    # cooling_type per server_id exactly, since that's what gets stored on
    # the Server record and used for WUE lookups; this dict only affects
    # the per-reading CoolingTelemetry.cooling_type field shown on Server
    # Detail, which should agree with it.
    "S7": "Hybrid",
    "S8": "Hybrid",
    "S9": "Liquid",
    "S10": "Liquid",
    "S11": "Air",
    "S12": "Air",
    "S13": "Air",
}


INTERVAL_SECONDS = 15


# ---------------------------------------------------------------------------
# Fetch live load (same pattern as power_monitor.py's get_current_load())
# ---------------------------------------------------------------------------

def get_current_cpu():
    """Fetch each server's latest CPU so cooling can respond to real load."""
    try:
        response = requests.get(f"{API_BASE}/servers", timeout=5)
        if response.status_code == 200:
            return {s["server_id"]: s.get("cpu") for s in response.json()}
    except requests.exceptions.RequestException:
        pass
    return {}


# ---------------------------------------------------------------------------
# Generate cooling telemetry
# ---------------------------------------------------------------------------

def generate_reading(server_id, cooling_type, cpu):

    cpu = FALLBACK_CPU_PERCENT if cpu is None else cpu
    cpu_fraction = max(0.0, min(1.0, cpu / 100.0))

    temp_rise = COOLING_TEMP_RISE_C.get(cooling_type, COOLING_TEMP_RISE_C["Air"]) * cpu_fraction
    temperature = round(
        BASE_TEMPERATURE_C + temp_rise + random.uniform(-TEMPERATURE_NOISE_C, TEMPERATURE_NOISE_C),
        2,
    )

    efficiency_drop = COOLING_EFFICIENCY_DROP.get(cooling_type, COOLING_EFFICIENCY_DROP["Air"]) * cpu_fraction
    efficiency = round(
        max(
            0.4,
            min(
                0.99,
                BASE_EFFICIENCY - efficiency_drop + random.uniform(-EFFICIENCY_NOISE, EFFICIENCY_NOISE),
            ),
        ),
        3,
    )

    return {
        "server_id": server_id,

        "inlet_temperature_c": temperature,

        "cooling_efficiency": efficiency,

        "cooling_type": cooling_type,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():

    print("=" * 60)
    print("GreenOps Cooling Telemetry Simulator")
    print("=" * 60)

    print(
        f"\nCooling monitor running."
        f" Posting every {INTERVAL_SECONDS}s."
    )

    print(
        "\nServers:",
        ", ".join(SERVER_COOLING.keys())
    )

    print("\nPress Ctrl+C to stop.\n")

    while True:

        current_load = get_current_cpu()

        for sid, cooling_type in SERVER_COOLING.items():

            reading = generate_reading(
                sid,
                cooling_type,
                current_load.get(sid),
            )

            try:

                response = requests.post(
                    f"{API_BASE}/telemetry/cooling",
                    json=reading,
                    timeout=5,
                )

                if response.status_code != 200:

                    print(
                        f"[cooling] {sid} -> "
                        f"{response.status_code} "
                        f"{response.text}"
                    )

                else:

                    print(
                        f"[cooling] {sid} -> "
                        f"Type {cooling_type} | "
                        f"Temperature "
                        f"{reading['inlet_temperature_c']:.1f} °C | "
                        f"Efficiency "
                        f"{reading['cooling_efficiency']:.3f}"
                    )

            except requests.exceptions.ConnectionError:

                print(
                    "[cooling] Backend not reachable, "
                    "retrying next cycle..."
                )

        time.sleep(INTERVAL_SECONDS)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    main()