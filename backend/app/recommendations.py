"""
GreenOps Recommendation Engine.

Converts active rule-based flags into operator-facing recommendations,
estimates the impact of acting on them (including, for consolidation, an
actual candidate-target simulation with a safety check), and ranks pending
recommendations using organization-configurable weights.

This module does NOT perform infrastructure changes.
It only recommends, estimates, and records operator decisions.
"""

from datetime import datetime, timedelta

import pandas as pd
from sqlalchemy.orm import Session

from . import compliance, forecasting, models, rules_engine


# ------------------------------------------------------------
# Recommendation mapping
# ------------------------------------------------------------

RECOMMENDATION_MAP = {
    "idle_server": {
        "type": "consolidate",
    },

    "stale_data": {
        "type": "archive",
    },

    "duplicate_data": {
        "type": "deduplicate",
    },

    "overprovisioned": {
        "type": "rightsize",
    },
}


# ------------------------------------------------------------
# Priority
# ------------------------------------------------------------

PRIORITY_RANK = {
    "high": 3,
    "medium": 2,
    "low": 1,
}


def calculate_priority(flag):
    """
    Priority is primarily based on the severity assigned by
    the rule engine.

    A high severity flag becomes a high priority recommendation.
    """

    severity = (flag.severity or "low").lower()

    if severity == "high":
        return "high"

    if severity == "medium":
        return "medium"

    return "low"


# ------------------------------------------------------------
# Create / update recommendations
# ------------------------------------------------------------

def sync_recommendations(db: Session):
    """
    Convert every active Flag into a Recommendation.

    Existing recommendations are updated instead of duplicated.

    A snoozed recommendation whose snooze window has passed is
    reopened as pending so the underlying waste isn't silently
    forgotten.
    """

    active_flags = (
        db.query(models.Flag)
        .filter(models.Flag.resolved == 0)
        .order_by(models.Flag.created_at.desc())
        .all()
    )

    created = 0
    updated = 0
    now = datetime.utcnow()

    for flag in active_flags:

        mapping = RECOMMENDATION_MAP.get(flag.flag_type)

        if not mapping:
            continue

        recommendation = (
            db.query(models.Recommendation)
            .filter(
                models.Recommendation.flag_id == flag.id
            )
            .first()
        )

        priority = calculate_priority(flag)

        explanation = flag.detail or ""

        if recommendation:

            recommendation.server_id = flag.server_id
            recommendation.recommendation_type = mapping["type"]
            recommendation.priority = priority
            recommendation.explanation = explanation

            if recommendation.status == "snoozed" and (
                recommendation.snoozed_until is None
                or recommendation.snoozed_until <= now
            ):
                recommendation.status = "pending"
                recommendation.snoozed_until = None

            elif recommendation.status not in (
                "accepted",
                "rejected",
                "snoozed",
            ):
                recommendation.status = "pending"

            updated += 1

        else:

            recommendation = models.Recommendation(
                flag_id=flag.id,
                server_id=flag.server_id,
                recommendation_type=mapping["type"],
                priority=priority,
                explanation=explanation,
                status="pending",
            )

            db.add(recommendation)
            created += 1

    active_flag_ids = [flag.id for flag in active_flags]

    withdrawn = (
        db.query(models.Recommendation)
        .filter(
            models.Recommendation.status == "pending",
            ~models.Recommendation.flag_id.in_(active_flag_ids),
        )
        .all()
    )

    for recommendation in withdrawn:
        recommendation.status = "withdrawn"

    db.commit()

    return {
        "created": created,
        "updated": updated,
        "withdrawn": len(withdrawn),
    }


# ------------------------------------------------------------
# What-if calculations
# ------------------------------------------------------------

TARIFF_PER_KWH = 8.0

# Carbon intensity is read per request from compliance.emission_factor(db)
# (the configurable, sourced value in site_settings), not a constant here.

CONSOLIDATION_OVERHEAD_FACTOR = 0.9

SAFETY_LIMIT_PERCENT = 75.0

# Network safety limit -- a stated convention, not derived from data, same
# spirit as the idle-threshold clamp. server_monitor.py's live network
# formula (workload x 25 Gbps + noise) has no real notion of "capacity" to
# check a percentage against, unlike CPU/memory which are naturally bounded
# 0-100%, so this picks a real-world reference instead: a standard 25GbE
# NIC, at the same 75% margin already used for CPU/memory.
NETWORK_CAPACITY_GBPS = 25.0
NETWORK_SAFETY_LIMIT_GBPS = NETWORK_CAPACITY_GBPS * (SAFETY_LIMIT_PERCENT / 100)

# Thermal safety limit -- checked against a PREDICTED post-move inlet
# temperature, not a raw sum (temperatures don't add across servers the way
# CPU/memory/network load does). The prediction reuses cooling_monitor.py's
# own generating formula (base + per-cooling-type rise x cpu fraction),
# driven by the target's post_move_cpu, since that's what would actually
# happen to its temperature once it takes on the extra workload. These
# constants MUST be kept in sync with simulators/cooling_monitor.py's
# BASE_TEMPERATURE_C / COOLING_TEMP_RISE_C -- duplicated here rather than
# shared (the simulators and backend are already two separate deployables
# with no shared package, the same reason WUE_FACTORS is independently
# duplicated in rules_engine.py and twice more in the frontend). 30C is a
# stated ceiling inspired by ASHRAE's allowable inlet-temperature range for
# data center equipment (~32C upper bound for standard classes), not derived
# from this project's own data.
THERMAL_BASE_TEMPERATURE_C = 19.0
THERMAL_COOLING_TEMP_RISE_C = {"Air": 9.0, "Hybrid": 5.0, "Liquid": 2.5}
THERMAL_SAFETY_LIMIT_C = 30.0

STORAGE_ACTION_RISK = 0.1


def _latest(db: Session, model, server_id: str):
    """
    Return the latest telemetry row for a server.
    """

    return (
        db.query(model)
        .filter(model.server_id == server_id)
        .order_by(model.timestamp.desc())
        .first()
    )


def _actively_idle_server_ids(db: Session) -> set:
    """
    Servers currently carrying an unresolved idle_server flag.

    These are never valid consolidation targets because they
    are themselves candidates for consolidation.
    """

    rows = (
        db.query(models.Flag.server_id)
        .filter(
            models.Flag.flag_type == "idle_server",
            models.Flag.resolved == 0,
        )
        .all()
    )

    return {row[0] for row in rows}


def _predict_power_kw(
    power_model,
    server_meta,
    cooling,
    pue,
    cpu_value,
    memory_value,
    network_value,
    workload_value,
):
    """
    Reuse the trained power model exactly as /servers/{id}/prediction does.

    calculate_what_if() uses this as the primary basis for its post-move
    energy estimate when both the model and the target's cooling telemetry
    are available; otherwise it falls back to a simpler CPU-ratio formula.
    """

    if power_model is None or cooling is None:
        return None

    features = pd.DataFrame([{
        "workload_intensity": workload_value,
        "memory_utilization": memory_value,
        "network_throughput_gbps": network_value,
        "inlet_temperature_c": cooling.inlet_temperature_c,
        "cooling_efficiency": cooling.cooling_efficiency,
        "pue": pue,
        "server_type": server_meta.server_type,
        "cooling_type": server_meta.cooling_type,
        "datacenter_region": server_meta.datacenter_region,
        "time_of_day": rules_engine.get_time_of_day(cooling.timestamp),
        "cpu_utilization": cpu_value,
    }])

    return float(
        power_model.predict(features)[0]
    )


def _rank_consolidation_candidates(
    db: Session,
    source_server,
    source_telemetry,
):
    """
    Implements the what-if consolidation algorithm.

    Candidates are same-type servers that aren't themselves idle.

    Every candidate is checked for whether it can safely absorb the source
    workload, TWICE: once against its current snapshot, and once against
    its own near-term forecast (forecasting.forecast_candidate_server()).

    Why both: a target passing only the current-snapshot check can still be
    a bad pick -- it might be about to get busy on its own, independent of
    anything this system does, and the snapshot check has no way to see
    that. A candidate only counts as safe when BOTH checks pass. When a
    forecast isn't available yet (not enough history), the forecast check
    is skipped rather than treated as a failure -- missing data shouldn't
    block a recommendation that the current-state check already approved.

    Candidates are returned ranked:

        1. Safe candidates first
        2. Lowest resulting utilization first (current vs. forecasted,
           whichever is worse -- ranking conservatively)

    This allows the operator to see what was considered and why.
    """

    idle_ids = _actively_idle_server_ids(db)

    candidates = (
        db.query(models.Server)
        .filter(
            models.Server.server_type == source_server.server_type,
            models.Server.server_id != source_server.server_id,
        )
        .all()
    )

    ranked = []

    for candidate in candidates:

        # Never move workload onto another server that is
        # itself currently flagged as idle.
        if candidate.server_id in idle_ids:
            continue

        target_telemetry = _latest(
            db,
            models.ServerTelemetry,
            candidate.server_id,
        )

        if target_telemetry is None:
            continue

        current_cpu = float(
            target_telemetry.cpu_utilization or 0
        )

        current_memory = float(
            target_telemetry.memory_utilization or 0
        )

        source_cpu = float(
            source_telemetry.cpu_utilization or 0
        )

        source_memory = float(
            source_telemetry.memory_utilization or 0
        )

        # ----------------------------------------------------
        # Simulated post-move utilization
        # ----------------------------------------------------

        post_move_cpu = (
            current_cpu
            + source_cpu * CONSOLIDATION_OVERHEAD_FACTOR
        )

        post_move_memory = (
            current_memory
            + source_memory * CONSOLIDATION_OVERHEAD_FACTOR
        )

        current_network = float(
            target_telemetry.network_throughput_gbps or 0
        )

        source_network = float(
            source_telemetry.network_throughput_gbps or 0
        )

        post_move_network = (
            current_network
            + source_network * CONSOLIDATION_OVERHEAD_FACTOR
        )

        network_ok = post_move_network < NETWORK_SAFETY_LIMIT_GBPS

        # Kept separate from safe_now (below) specifically so the frontend
        # can still show a candidate that's only rejected on network/thermal
        # grounds -- those are newer, less-established conventions than the
        # CPU/memory limit, and an operator should be able to see and judge
        # them the same way a "risky soon" forecast rejection stays visible,
        # rather than having them vanish from the list the same way a
        # genuinely CPU/memory-over-limit-right-now candidate does.
        cpu_memory_ok_now = (
            post_move_cpu < SAFETY_LIMIT_PERCENT
            and post_move_memory < SAFETY_LIMIT_PERCENT
        )

        # Predicted post-move inlet temperature -- NOT a sum of two
        # servers' temperatures (that isn't physically meaningful). This
        # applies cooling_monitor.py's own load->temperature formula to the
        # target's post-move CPU, i.e. "what would this target's own
        # temperature become once it's carrying the extra workload."
        predicted_post_move_temp_c = (
            THERMAL_BASE_TEMPERATURE_C
            + THERMAL_COOLING_TEMP_RISE_C.get(
                candidate.cooling_type,
                THERMAL_COOLING_TEMP_RISE_C["Air"],
            )
            * min(1.0, post_move_cpu / 100)
        )

        thermal_ok = predicted_post_move_temp_c < THERMAL_SAFETY_LIMIT_C

        # ----------------------------------------------------
        # Safety check -- current snapshot
        # ----------------------------------------------------

        safe_now = (
            cpu_memory_ok_now
            and network_ok
            and thermal_ok
        )

        headroom_used_now = max(
            post_move_cpu,
            post_move_memory,
        )

        # ----------------------------------------------------
        # Safety check -- candidate's own near-term forecast
        #
        # A target can look safe right now and still be a bad
        # pick if it's about to get busy on its own -- the
        # snapshot check above has no way to see that. This
        # forecasts the candidate's OWN CPU/memory 15 minutes
        # out (independent of the move), then adds the same
        # source contribution used above.
        # ----------------------------------------------------

        forecast = forecasting.forecast_candidate_server(
            db,
            candidate.server_id,
        )

        forecast_available = bool(
            forecast.get("eligible")
            and forecast.get("predicted_cpu") is not None
            and forecast.get("predicted_memory") is not None
        )

        if forecast_available:

            forecast_post_move_cpu = (
                forecast["predicted_cpu"]
                + source_cpu * CONSOLIDATION_OVERHEAD_FACTOR
            )

            forecast_post_move_memory = (
                forecast["predicted_memory"]
                + source_memory * CONSOLIDATION_OVERHEAD_FACTOR
            )

            safe_forecast = (
                forecast_post_move_cpu < SAFETY_LIMIT_PERCENT
                and forecast_post_move_memory < SAFETY_LIMIT_PERCENT
            )

            headroom_used_forecast = max(
                forecast_post_move_cpu,
                forecast_post_move_memory,
            )

        else:

            forecast_post_move_cpu = None
            forecast_post_move_memory = None

            # No forecast yet (not enough history) -- don't let
            # missing data block a recommendation the snapshot
            # check already approved.
            safe_forecast = True
            headroom_used_forecast = headroom_used_now

        # A candidate only counts as safe when both checks agree.
        safe = safe_now and safe_forecast

        # Rank by whichever view is worse, so a candidate that
        # looks fine now but risky soon doesn't outrank one that's
        # genuinely safe on both counts.
        headroom_used = max(
            headroom_used_now,
            headroom_used_forecast,
        )

        ranked.append({
            "server": candidate,
            "telemetry": target_telemetry,

            "current_cpu": current_cpu,
            "current_memory": current_memory,

            "post_move_cpu": post_move_cpu,
            "post_move_memory": post_move_memory,

            "post_move_network_gbps": post_move_network,
            "network_ok": network_ok,

            "predicted_post_move_temp_c": predicted_post_move_temp_c,
            "thermal_ok": thermal_ok,

            "cpu_memory_ok_now": cpu_memory_ok_now,
            "safe_now": safe_now,

            "forecast_available": forecast_available,
            "forecast_predicted_cpu": forecast.get("predicted_cpu"),
            "forecast_predicted_memory": forecast.get("predicted_memory"),
            "forecast_post_move_cpu": forecast_post_move_cpu,
            "forecast_post_move_memory": forecast_post_move_memory,
            "safe_forecast": safe_forecast,

            "safe": safe,
            "headroom_used": headroom_used,
        })

    ranked.sort(
        key=lambda c: (
            not c["safe"],
            c["headroom_used"],
        )
    )

    return ranked


def calculate_what_if(
    db: Session,
    recommendation,
    power_model=None,
):
    """
    Estimate the environmental and resource impact of applying
    a recommendation.

    This is a decision-support estimate only.
    No physical infrastructure changes are performed.

    For consolidation:

        Energy Before
            = source facility power
            + target facility power

        Energy After
            = trained power model's prediction for the target's
              full post-move profile (CPU, memory, network,
              cooling), scaled from IT power to facility power
              by the target's current PUE

              -- falls back to --

            = target facility power
            × post-move CPU / current target CPU

              when the power model or the target's cooling
              telemetry isn't available

        Energy Saving
            = energy before - energy after

        Carbon Before
            = energy before × carbon intensity

        Carbon After
            = energy after × carbon intensity

        Carbon Reduction
            = carbon before - carbon after

        Cost Before
            = energy before × tariff

        Cost After
            = energy after × tariff

        Cost Saving
            = cost before - cost after

        Water Before
            = energy before × water factor

        Water After
            = energy after × water factor

        Water Saving
            = water before - water after

    Carbon/cost/water are always simple formulas on top of energy.
    Energy itself prefers the trained power model (see Energy After
    above) but degrades gracefully to a formula-only estimate when
    the model or target cooling telemetry isn't available -- this
    function never raises just because the model is missing.
    """

    server_id = recommendation.server_id

    result = {
        "recommendation_id": recommendation.id,
        "server_id": server_id,
        "action": recommendation.recommendation_type,

        # ----------------------------------------------------
        # Savings
        # ----------------------------------------------------

        "estimated_energy_saving_kwh": 0.0,
        "estimated_carbon_reduction_kg": 0.0,
        "estimated_cost_saving": 0.0,
        "estimated_water_saving_l": 0.0,
        "estimated_storage_reclaimed_gb": 0.0,

        # ----------------------------------------------------
        # Before / After values
        # ----------------------------------------------------

        "estimated_energy_before_kwh": None,
        "estimated_energy_after_kwh": None,

        "estimated_carbon_before_kg": None,
        "estimated_carbon_after_kg": None,

        "estimated_cost_before": None,
        "estimated_cost_after": None,

        "estimated_water_before_l": None,
        "estimated_water_after_l": None,

        # ----------------------------------------------------
        # Consolidation target
        # ----------------------------------------------------

        "target_server_id": None,

        # ----------------------------------------------------
        # Safety
        # ----------------------------------------------------

        "safe": None,
        "risk_score": None,

        # ----------------------------------------------------
        # Explanation
        # ----------------------------------------------------

        "assumptions": [],
    }

    # ========================================================
    # CONSOLIDATION
    # ========================================================

    if recommendation.recommendation_type == "consolidate":

        source_server = (
            db.query(models.Server)
            .filter(
                models.Server.server_id == server_id
            )
            .first()
        )

        source_telemetry = _latest(
            db,
            models.ServerTelemetry,
            server_id,
        )

        source_power = _latest(
            db,
            models.PowerTelemetry,
            server_id,
        )

        # ----------------------------------------------------
        # Validate source data
        # ----------------------------------------------------

        if source_server is None or source_telemetry is None:

            result["safe"] = False

            result["assumptions"].append(
                "Not enough telemetry for this server to evaluate a move."
            )

            return result

        # ----------------------------------------------------
        # Find and rank target candidates
        # ----------------------------------------------------

        ranked = _rank_consolidation_candidates(
            db,
            source_server,
            source_telemetry,
        )

        # ----------------------------------------------------
        # Expose candidates to frontend
        # ----------------------------------------------------

        result["candidates"] = [
            {
                "server_id": c["server"].server_id,

                "safe": c["safe"],
                "safe_now": c["safe_now"],
                "safe_forecast": c["safe_forecast"],
                "forecast_available": c["forecast_available"],

                "current_cpu": round(
                    c["current_cpu"],
                    2,
                ),

                "current_memory": round(
                    c["current_memory"],
                    2,
                ),

                "post_move_cpu": round(
                    c["post_move_cpu"],
                    2,
                ),

                "post_move_memory": round(
                    c["post_move_memory"],
                    2,
                ),

                "post_move_network_gbps": round(
                    c["post_move_network_gbps"],
                    2,
                ),
                "network_ok": c["network_ok"],

                "predicted_post_move_temp_c": round(
                    c["predicted_post_move_temp_c"],
                    2,
                ),
                "thermal_ok": c["thermal_ok"],

                "cpu_memory_ok_now": c["cpu_memory_ok_now"],

                "forecast_predicted_cpu": (
                    round(c["forecast_predicted_cpu"], 2)
                    if c["forecast_predicted_cpu"] is not None
                    else None
                ),

                "forecast_predicted_memory": (
                    round(c["forecast_predicted_memory"], 2)
                    if c["forecast_predicted_memory"] is not None
                    else None
                ),

                "forecast_post_move_cpu": (
                    round(c["forecast_post_move_cpu"], 2)
                    if c["forecast_post_move_cpu"] is not None
                    else None
                ),

                "forecast_post_move_memory": (
                    round(c["forecast_post_move_memory"], 2)
                    if c["forecast_post_move_memory"] is not None
                    else None
                ),
            }

            for c in ranked[:5]
        ]

        safe_candidates = [
            c
            for c in ranked
            if c["safe"]
        ]

        # ----------------------------------------------------
        # No safe candidate
        # ----------------------------------------------------

        if not safe_candidates:

            result["safe"] = False
            result["risk_score"] = 1.0

            if ranked:

                rejected_only_by_forecast = sum(
                    1
                    for c in ranked
                    if c["safe_now"] and not c["safe_forecast"]
                )

                rejected_by_network = sum(
                    1 for c in ranked if not c["network_ok"]
                )

                rejected_by_thermal = sum(
                    1 for c in ranked if not c["thermal_ok"]
                )

                result["assumptions"].append(
                    f"{len(ranked)} same-type server(s) considered, "
                    f"but none has headroom to absorb this workload "
                    f"without crossing {SAFETY_LIMIT_PERCENT:.0f}% "
                    "CPU or memory, saturating its network link, or "
                    "running too hot -- rejected, not recommended to act on."
                )

                if rejected_only_by_forecast:

                    result["assumptions"].append(
                        f"{rejected_only_by_forecast} candidate(s) looked "
                        "safe based on their CURRENT load, but were "
                        "rejected because their own near-term forecast "
                        f"shows them crossing {SAFETY_LIMIT_PERCENT:.0f}% "
                        "on their own, independent of this move -- see "
                        "each candidate's forecast columns above."
                    )

                if rejected_by_network:

                    result["assumptions"].append(
                        f"{rejected_by_network} candidate(s) rejected on "
                        f"network grounds -- post-move throughput would "
                        f"exceed {NETWORK_SAFETY_LIMIT_GBPS:.1f} Gbps "
                        f"(75% of an assumed {NETWORK_CAPACITY_GBPS:.0f} Gbps "
                        "NIC capacity, a stated convention, not a measured "
                        "limit)."
                    )

                if rejected_by_thermal:

                    result["assumptions"].append(
                        f"{rejected_by_thermal} candidate(s) rejected on "
                        f"thermal grounds -- predicted post-move inlet "
                        f"temperature would exceed {THERMAL_SAFETY_LIMIT_C:.0f}"
                        "°C, estimated from the target's own cooling "
                        "type and post-move CPU, not a raw sensor reading."
                    )

            else:

                result["assumptions"].append(
                    f"No other {source_server.server_type} server exists "
                    "to evaluate as a target -- rejected, not recommended "
                    "to act on."
                )

            return result

        # ----------------------------------------------------
        # Best safe candidate
        # ----------------------------------------------------

        best = safe_candidates[0]

        target = best["server"]

        target_telemetry = best["telemetry"]

        post_move_cpu = best["post_move_cpu"]

        post_move_memory = best["post_move_memory"]

        result["target_server_id"] = target.server_id

        result["safe"] = True

        if best["forecast_available"]:

            result["assumptions"].append(
                f"{target.server_id}'s own near-term forecast (independent "
                f"of this move) predicts {best['forecast_predicted_cpu']:.1f}% "
                f"CPU / {best['forecast_predicted_memory']:.1f}% memory in "
                f"{forecasting.FORECAST_HORIZON_MINUTES} minutes -- combined "
                "with this workload, it would stay under the safety limit "
                "on that basis too, not just right now."
            )

        else:

            result["assumptions"].append(
                f"{target.server_id} doesn't have enough history yet for a "
                "near-term forecast -- this candidate was judged on its "
                "current snapshot only."
            )

        # Risk score:
        # 0 = very low utilization relative to safety limit
        # 1 = exactly at safety limit
        result["risk_score"] = round(
            max(
                post_move_cpu,
                post_move_memory,
            )
            / SAFETY_LIMIT_PERCENT,
            2,
        )

        # ----------------------------------------------------
        # Before → After utilization values
        # ----------------------------------------------------

        result["target_current_cpu"] = round(
            best["current_cpu"],
            2,
        )

        result["target_current_memory"] = round(
            best["current_memory"],
            2,
        )

        result["source_current_cpu"] = round(
            float(
                source_telemetry.cpu_utilization or 0
            ),
            2,
        )

        result["source_current_memory"] = round(
            float(
                source_telemetry.memory_utilization or 0
            ),
            2,
        )

        result["post_move_cpu"] = round(
            post_move_cpu,
            2,
        )

        result["post_move_memory"] = round(
            post_move_memory,
            2,
        )

        # ----------------------------------------------------
        # Target power telemetry
        # ----------------------------------------------------

        target_power = _latest(
            db,
            models.PowerTelemetry,
            target.server_id,
        )

        target_cooling = _latest(
            db,
            models.CoolingTelemetry,
            target.server_id,
        )

        # ====================================================
        # FORMULA-BASED ENVIRONMENTAL IMPACT
        # ====================================================

        if source_power and target_power:

            source_facility_power_kw = float(
                source_power.facility_power_kw or 0
            )

            target_facility_power_kw = float(
                target_power.facility_power_kw or 0
            )

            # ------------------------------------------------
            # 1. ENERGY BEFORE
            #
            # Both source and target servers are currently
            # running.
            #
            # Since the reporting period is one hour:
            #
            # kW × 1 hour = kWh
            # ------------------------------------------------

            energy_before_kwh = (
                source_facility_power_kw
                + target_facility_power_kw
            )

            # ------------------------------------------------
            # 2. ENERGY AFTER
            #
            # Source server is assumed to be powered down
            # after successful consolidation.
            #
            # Preferred method: the trained power model's
            # prediction for the target's full post-move
            # profile (CPU, memory, network, cooling) -- now
            # that train_model.py rescales the model's output
            # to the same range live telemetry occupies, this
            # is more informative than a single linear CPU
            # scale, since it accounts for memory/network too.
            #
            # Falls back to the transparent CPU-ratio formula
            # only when the model or the target's cooling
            # telemetry isn't available.
            # ------------------------------------------------

            current_target_cpu = float(
                target_telemetry.cpu_utilization or 0
            )

            target_pue = None
            predicted_it_kw = None

            if power_model is not None and target_cooling is not None:

                target_pue = rules_engine.compute_pue(
                    target_power.it_power_kw,
                    target_power.facility_power_kw,
                )

                predicted_it_kw = _predict_power_kw(
                    power_model,
                    target,
                    target_cooling,
                    pue=target_pue,
                    cpu_value=post_move_cpu,
                    memory_value=post_move_memory,
                    network_value=(
                        target_telemetry.network_throughput_gbps
                        or 0
                    )
                    +
                    (
                        source_telemetry.network_throughput_gbps
                        or 0
                    )
                    * CONSOLIDATION_OVERHEAD_FACTOR,
                    workload_value=min(
                        1.0,
                        (
                            target_telemetry.workload_intensity
                            or 0
                        )
                        +
                        (
                            source_telemetry.workload_intensity
                            or 0
                        )
                        * CONSOLIDATION_OVERHEAD_FACTOR,
                    ),
                )

            used_model_for_estimate = (
                predicted_it_kw is not None
                and target_pue
            )

            if used_model_for_estimate:

                # IT power -> facility power via the target's own
                # current PUE, same relationship power_monitor.py
                # itself uses (facility = IT x overhead ratio).
                predicted_after_kw = (
                    predicted_it_kw
                    * target_pue
                )

                cpu_ratio = None

            else:

                if current_target_cpu > 0:

                    cpu_ratio = (
                        post_move_cpu
                        / current_target_cpu
                    )

                else:

                    cpu_ratio = 1.0

                predicted_after_kw = (
                    target_facility_power_kw
                    * cpu_ratio
                )

            energy_after_kwh = max(
                predicted_after_kw,
                0.0,
            )

            # ------------------------------------------------
            # 3. ENERGY SAVING
            # ------------------------------------------------

            energy_saved = max(
                energy_before_kwh
                - energy_after_kwh,
                0.0,
            )

            result[
                "estimated_energy_before_kwh"
            ] = round(
                energy_before_kwh,
                2,
            )

            result[
                "estimated_energy_after_kwh"
            ] = round(
                energy_after_kwh,
                2,
            )

            result[
                "estimated_energy_saving_kwh"
            ] = round(
                energy_saved,
                2,
            )

            # ------------------------------------------------
            # 4. CARBON BEFORE
            # ------------------------------------------------

            emission_factor = compliance.emission_factor(db)
            result["emission_factor_kg_per_kwh"] = emission_factor

            carbon_before_kg = (
                energy_before_kwh
                * emission_factor
            )

            # ------------------------------------------------
            # 5. CARBON AFTER
            # ------------------------------------------------

            carbon_after_kg = (
                energy_after_kwh
                * emission_factor
            )

            # ------------------------------------------------
            # 6. CARBON REDUCTION
            # ------------------------------------------------

            carbon_reduction_kg = max(
                carbon_before_kg
                - carbon_after_kg,
                0.0,
            )

            result[
                "estimated_carbon_before_kg"
            ] = round(
                carbon_before_kg,
                2,
            )

            result[
                "estimated_carbon_after_kg"
            ] = round(
                carbon_after_kg,
                2,
            )

            result[
                "estimated_carbon_reduction_kg"
            ] = round(
                carbon_reduction_kg,
                2,
            )

            # ------------------------------------------------
            # 7. COST BEFORE
            # ------------------------------------------------

            cost_before = (
                energy_before_kwh
                * TARIFF_PER_KWH
            )

            # ------------------------------------------------
            # 8. COST AFTER
            # ------------------------------------------------

            cost_after = (
                energy_after_kwh
                * TARIFF_PER_KWH
            )

            # ------------------------------------------------
            # 9. COST SAVING
            # ------------------------------------------------

            cost_saving = max(
                cost_before
                - cost_after,
                0.0,
            )

            result[
                "estimated_cost_before"
            ] = round(
                cost_before,
                2,
            )

            result[
                "estimated_cost_after"
            ] = round(
                cost_after,
                2,
            )

            result[
                "estimated_cost_saving"
            ] = round(
                cost_saving,
                2,
            )

            # ------------------------------------------------
            # 10. WATER BEFORE / AFTER
            # ------------------------------------------------

            water_factor = rules_engine.WUE_FACTORS.get(
                source_server.cooling_type,
                0.5,
            )

            water_before_l = (
                energy_before_kwh
                * water_factor
            )

            water_after_l = (
                energy_after_kwh
                * water_factor
            )

            water_saving_l = max(
                water_before_l
                - water_after_l,
                0.0,
            )

            result[
                "estimated_water_before_l"
            ] = round(
                water_before_l,
                2,
            )

            result[
                "estimated_water_after_l"
            ] = round(
                water_after_l,
                2,
            )

            result[
                "estimated_water_saving_l"
            ] = round(
                water_saving_l,
                2,
            )

            # ------------------------------------------------
            # Explain calculation
            # ------------------------------------------------

            result["assumptions"].append(
                f"Estimated over one hour: moving {server_id}'s "
                f"workload onto {target.server_id} would change "
                f"the target from {best['current_cpu']:.1f}% CPU / "
                f"{best['current_memory']:.1f}% memory to "
                f"{post_move_cpu:.1f}% CPU / "
                f"{post_move_memory:.1f}% memory."
            )

            result["assumptions"].append(
                f"Also checked: post-move network throughput "
                f"({best['post_move_network_gbps']:.1f} Gbps, limit "
                f"{NETWORK_SAFETY_LIMIT_GBPS:.1f}) and predicted post-move "
                f"inlet temperature ({best['predicted_post_move_temp_c']:.1f}"
                f"°C, limit {THERMAL_SAFETY_LIMIT_C:.0f}°C) -- both "
                "within limits for this candidate. Both are stated "
                "conventions, not measured capacities."
            )

            result["assumptions"].append(
                f"Energy before = source facility power "
                f"({source_facility_power_kw:.2f} kW) + target "
                f"facility power ({target_facility_power_kw:.2f} kW)."
            )

            if used_model_for_estimate:

                result["assumptions"].append(
                    f"Energy after uses the trained power model's "
                    f"prediction for {target.server_id}'s full "
                    f"post-move profile (CPU, memory, network, "
                    f"cooling): {predicted_it_kw:.2f} kW IT power, "
                    f"scaled to facility power by its current PUE "
                    f"({target_pue:.2f}) -> {predicted_after_kw:.2f} kW. "
                    "The source server is assumed to be powered down."
                )

                result["assumptions"].append(
                    "The power model was trained on real data center "
                    "telemetry (rescaled to this system's live IT-power "
                    "range) -- its predicted relationship between load "
                    "and power is a real one, but was learned from "
                    "different servers than the ones being simulated "
                    "here, so treat this as an informed estimate, not "
                    "a measurement."
                )

            else:

                result["assumptions"].append(
                    f"Energy after = target facility power "
                    f"({target_facility_power_kw:.2f} kW) × "
                    f"post-move CPU ratio ({cpu_ratio:.2f}) -- the "
                    "trained power model wasn't available for this "
                    "target, so this simpler formula was used instead. "
                    "The source server is assumed to be powered down."
                )

            result["assumptions"].append(
                f"Carbon = energy × "
                f"{emission_factor:.3f} kg CO₂/kWh (grid emission factor "
                "from site settings)."
            )

            result["assumptions"].append(
                f"Electricity cost = energy × "
                f"₹{TARIFF_PER_KWH:.2f}/kWh."
            )

            result["assumptions"].append(
                f"Water = energy × "
                f"{water_factor:.2f} L/kWh based on the source "
                f"server's cooling type."
            )

            if used_model_for_estimate:

                result[
                    "model_predicted_target_it_power_kw"
                ] = round(
                    predicted_it_kw,
                    2,
                )

        else:

            result["assumptions"].append(
                "Power telemetry is unavailable for the source or "
                "target server, so energy, carbon, cost and water "
                "impact cannot be estimated."
            )

        return result

    # ========================================================
    # STORAGE ACTIONS
    # ========================================================

    if recommendation.recommendation_type in (
        "rightsize",
        "archive",
        "deduplicate",
    ):

        flag = (
            db.query(models.Flag)
            .filter(
                models.Flag.id == recommendation.flag_id
            )
            .first()
        )

        if flag:

            reclaimable = float(
                flag.metric_value or 0
            )

            result[
                "estimated_storage_reclaimed_gb"
            ] = round(
                reclaimable,
                2,
            )

            result["risk_score"] = STORAGE_ACTION_RISK

            result["safe"] = True

            reason_by_type = {
                "rightsize":
                    "Estimated reclaimable capacity is based on "
                    "allocated storage that is currently unused.",

                "archive":
                    "Estimated reclaimable storage is based on "
                    "the stale-data volume identified by the rule engine.",

                "deduplicate":
                    "Estimated reclaimable storage is based on "
                    "detected duplicate-data volume.",
            }

            result["assumptions"].append(
                reason_by_type[
                    recommendation.recommendation_type
                ]
            )

            result["assumptions"].append(
                "No energy/carbon/water effect is modeled for "
                "storage-only actions -- freeing capacity doesn't "
                "change a server's power draw in this system."
            )

        return result

    return result


# ------------------------------------------------------------
# Scoring / ranking
# ------------------------------------------------------------

def get_preferences(db: Session) -> models.Preferences:

    prefs = (
        db.query(models.Preferences)
        .filter(
            models.Preferences.id == 1
        )
        .first()
    )

    if prefs is None:

        prefs = models.Preferences(id=1)

        db.add(prefs)
        db.commit()
        db.refresh(prefs)

    return prefs


def _normalize(
    value: float,
    max_value: float,
) -> float:

    if not max_value or max_value <= 0:
        return 0.0

    return max(
        0.0,
        min(
            1.0,
            value / max_value,
        ),
    )


def rank_recommendations(
    rows_with_impact: list,
    preferences: models.Preferences,
) -> list:

    max_energy = max(
        (
            r["impact"][
                "estimated_energy_saving_kwh"
            ]
            for r in rows_with_impact
        ),
        default=0,
    )

    max_cost = max(
        (
            r["impact"][
                "estimated_cost_saving"
            ]
            for r in rows_with_impact
        ),
        default=0,
    )

    max_carbon = max(
        (
            r["impact"][
                "estimated_carbon_reduction_kg"
            ]
            for r in rows_with_impact
        ),
        default=0,
    )

    max_water = max(
        (
            r["impact"].get(
                "estimated_water_saving_l",
                0,
            )
            for r in rows_with_impact
        ),
        default=0,
    )

    for entry in rows_with_impact:

        impact = entry["impact"]

        risk = impact.get("risk_score")

        risk = (
            0.5
            if risk is None
            else risk
        )

        score = (
            preferences.energy_weight
            * _normalize(
                impact[
                    "estimated_energy_saving_kwh"
                ],
                max_energy,
            )
            +
            preferences.cost_weight
            * _normalize(
                impact[
                    "estimated_cost_saving"
                ],
                max_cost,
            )
            +
            preferences.carbon_weight
            * _normalize(
                impact[
                    "estimated_carbon_reduction_kg"
                ],
                max_carbon,
            )
            +
            preferences.water_weight
            * _normalize(
                impact.get(
                    "estimated_water_saving_l",
                    0,
                ),
                max_water,
            )
            -
            preferences.risk_weight
            * risk
        )

        entry["score"] = round(
            score,
            3,
        )

    rows_with_impact.sort(
        key=lambda entry: entry["score"],
        reverse=True,
    )

    return rows_with_impact


def get_recommendations(
    db: Session,
    include_completed=False,
    power_model=None,
):

    sync_recommendations(db)

    query = db.query(
        models.Recommendation
    )

    if not include_completed:

        query = query.filter(
            models.Recommendation.status == "pending"
        )

    rows = query.all()

    preferences = get_preferences(db)

    enriched = []

    for row in rows:

        impact = calculate_what_if(
            db,
            row,
            power_model=power_model,
        )

        enriched.append({
            "recommendation": row,
            "impact": impact,
        })

    return rank_recommendations(
        enriched,
        preferences,
    )


# ------------------------------------------------------------
# Operator decision
# ------------------------------------------------------------

def record_operator_action(
    db: Session,
    recommendation,
    action: str,
    notes=None,
    snooze_hours: float = 24,
    power_model=None,
):
    """
    Record the operator's decision on a recommendation.

    Supported operator actions:

        - consolidate
        - rightsize
        - snooze
        - do_nothing

    This records the decision only.
    It does NOT perform any physical infrastructure change.
    """

    valid_actions = {
        "consolidate",
        "rightsize",
        "snooze",
        "do_nothing",
    }

    if action not in valid_actions:

        raise ValueError(
            "Invalid operator action. "
            "Choose consolidate, rightsize, snooze, or do_nothing."
        )

    if action == "consolidate":

        if recommendation.recommendation_type != "consolidate":

            raise ValueError(
                "Consolidate action is only valid for "
                "consolidation recommendations."
            )

        recommendation.status = "accepted"

        recommendation.decided_at = datetime.utcnow()

    elif action == "rightsize":

        if recommendation.recommendation_type not in (
            "rightsize",
            "archive",
            "deduplicate",
        ):

            raise ValueError(
                "Rightsize action is only valid for "
                "storage recommendations."
            )

        recommendation.status = "accepted"

        recommendation.decided_at = datetime.utcnow()

    elif action == "snooze":

        recommendation.status = "snoozed"

        recommendation.snoozed_until = (
            datetime.utcnow()
            + timedelta(hours=snooze_hours)
        )

    elif action == "do_nothing":

        recommendation.status = "rejected"

        recommendation.decided_at = datetime.utcnow()

    # --------------------------------------------------------
    # Snapshot the impact estimate at decision time.
    # --------------------------------------------------------

    impact = calculate_what_if(
        db,
        recommendation,
        power_model=power_model,
    )

    operator_action = models.OperatorAction(
        recommendation_id=recommendation.id,
        server_id=recommendation.server_id,
        action=action,
        notes=notes,

        estimated_energy_saving_kwh=impact.get(
            "estimated_energy_saving_kwh"
        ),

        estimated_carbon_reduction_kg=impact.get(
            "estimated_carbon_reduction_kg"
        ),

        estimated_cost_saving=impact.get(
            "estimated_cost_saving"
        ),

        estimated_storage_reclaimed_gb=impact.get(
            "estimated_storage_reclaimed_gb"
        ),

        target_server_id=impact.get(
            "target_server_id"
        ),
    )

    db.add(operator_action)

    db.commit()

    db.refresh(operator_action)

    return operator_action