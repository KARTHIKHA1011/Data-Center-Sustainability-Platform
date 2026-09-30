from sqlalchemy import Column, Integer, Float, String, DateTime, Boolean, ForeignKey
from datetime import datetime
from .database import Base


class User(Base):
    """Authenticated GreenOps users with role-based access control."""
    __tablename__ = "users"

    id            = Column(Integer, primary_key=True, index=True)
    employee_id   = Column(String, unique=True, index=True, nullable=True)
    name          = Column(String, nullable=False)
    email         = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role          = Column(String, nullable=False)
    # Roles: infrastructure_manager | sustainability_manager | operations_engineer
    is_active     = Column(Boolean, default=True, nullable=False)
    created_at    = Column(DateTime, default=datetime.utcnow, nullable=False)


class Server(Base):
    __tablename__ = "servers"

    id = Column(Integer, primary_key=True, index=True)
    server_id = Column(String, unique=True, index=True)
    server_type = Column(String, default="Compute")
    cooling_type = Column(String, default="Air")
    datacenter_region = Column(String, default="APAC")


class ServerTelemetry(Base):
    __tablename__ = "server_telemetry"

    id = Column(Integer, primary_key=True, index=True)
    server_id = Column(String, index=True)
    cpu_utilization = Column(Float)
    memory_utilization = Column(Float)
    network_throughput_gbps = Column(Float)
    workload_intensity = Column(Float)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)


class PowerTelemetry(Base):
    __tablename__ = "power_telemetry"

    id = Column(Integer, primary_key=True, index=True)
    server_id = Column(String, index=True)
    it_power_kw = Column(Float)
    facility_power_kw = Column(Float)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)


class CoolingTelemetry(Base):
    __tablename__ = "cooling_telemetry"

    id = Column(Integer, primary_key=True, index=True)
    server_id = Column(String, index=True)
    inlet_temperature_c = Column(Float)
    cooling_efficiency = Column(Float)
    cooling_type = Column(String)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)


class StorageTelemetry(Base):
    __tablename__ = "storage_telemetry"

    id = Column(Integer, primary_key=True, index=True)
    server_id = Column(String, index=True)
    total_storage_gb = Column(Float)
    used_storage_gb = Column(Float)
    duplicate_data_gb = Column(Float)
    last_accessed_days_ago = Column(Integer)
    storage_type = Column(String)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)


class Forecast(Base):
    """Persisted near-term CPU/workload forecast for an eligible server."""
    __tablename__ = "forecasts"

    id = Column(Integer, primary_key=True, index=True)
    server_id = Column(String, index=True)
    horizon_minutes = Column(Integer, default=60)
    measured_cpu = Column(Float)
    predicted_cpu = Column(Float)
    method = Column(String, default="trend_extrapolation")
    model_version = Column(String, nullable=True)
    validation_mae = Column(Float, nullable=True)
    validation_rmse = Column(Float, nullable=True)
    validation_r2 = Column(Float, nullable=True)
    source_observations = Column(Integer, default=0)
    generated_at = Column(DateTime, default=datetime.utcnow, index=True)


class Flag(Base):
    """Rule-based optimization opportunity flags (idle server, stale data, etc.)"""
    __tablename__ = "flags"

    id = Column(Integer, primary_key=True, index=True)
    server_id = Column(String, index=True)
    flag_type = Column(String)          # idle_server, stale_data, duplicate_data, overprovisioned
    severity = Column(String)           # low, medium, high
    detail = Column(String)             # human-readable explanation
    metric_value = Column(Float)        # e.g. GB reclaimable, avg CPU, etc.
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    resolved = Column(Integer, default=0)  # 0 = active, 1 = resolved/cleared


class Recommendation(Base):
    """
    Recommendation generated from an active rule-based Flag.
    This is a decision-support record; it does not directly modify
    infrastructure.
    """
    __tablename__ = "recommendations"

    id = Column(Integer, primary_key=True, index=True)

    flag_id = Column(Integer, index=True, unique=True, nullable=False)

    server_id = Column(String, index=True, nullable=False)

    recommendation_type = Column(String, nullable=False)
    # consolidate, archive, deduplicate, rightsize

    priority = Column(String, nullable=False)
    # high, medium, low

    explanation = Column(String, nullable=False)

    status = Column(String, default="pending")
    # pending, blocked, accepted, rejected, snoozed

    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    decided_at = Column(DateTime, nullable=True)

    snoozed_until = Column(DateTime, nullable=True)
    # Set when an operator snoozes a recommendation instead of rejecting it
    # outright. sync_recommendations() resets status back to "pending" once
    # this passes, so the flag isn't lost -- just deferred.


class OperatorAction(Base):
    """
    Stores the operator's decision on a recommendation, plus a snapshot of
    the estimated impact at the moment the decision was made. The snapshot
    is what was ESTIMATED then, not a verified after-the-fact measurement --
    GreenOps still has no AUTOMATIC way to confirm a consolidation actually
    happened. executed_at/execution_note (below) let an operator manually
    confirm it did, once they've actually done it -- a human attestation,
    not a verification.
    """
    __tablename__ = "operator_actions"

    id = Column(Integer, primary_key=True, index=True)

    recommendation_id = Column(
        Integer,
        index=True,
        nullable=False
    )

    server_id = Column(String, index=True, nullable=False)

    action = Column(String, nullable=False)
    # consolidate, rightsize, snooze, do_nothing

    notes = Column(String, nullable=True)

    # Impact estimate captured at decision time (from calculate_what_if()),
    # so the decision log can show what was estimated without recomputing
    # against fleet state that has since moved on.
    estimated_energy_saving_kwh = Column(Float, nullable=True)
    estimated_carbon_reduction_kg = Column(Float, nullable=True)
    estimated_cost_saving = Column(Float, nullable=True)
    estimated_storage_reclaimed_gb = Column(Float, nullable=True)
    target_server_id = Column(String, nullable=True)
    # The candidate server selected for a consolidate action, if any.

    # Set when the operator confirms the action has actually been carried
    # out. NULL means approved but not yet executed. GreenOps cannot verify
    # this automatically -- it relies entirely on the operator marking it.
    executed_at = Column(DateTime, nullable=True)
    execution_note = Column(String, nullable=True)

    # Audit trail: which user approved/rejected/snoozed this action.
    decided_by_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    decided_by_name    = Column(String, nullable=True)   # snapshot at decision time
    decided_by_role    = Column(String, nullable=True)   # snapshot at decision time

    created_at = Column(
        DateTime,
        default=datetime.utcnow,
        index=True
    )


class SiteSettings(Base):
    """
    Single-row (id=1) site configuration used by the reporting and compliance
    layer: the grid emission factor behind every carbon figure, and the
    operator-DECLARED values GreenOps cannot derive from telemetry (installed
    IT capacity, renewable energy factor, energy reuse factor).

    Declared values are never inferred. A NULL means "not declared", and the
    compliance report shows the matching indicator as missing rather than
    inventing a number.
    """
    __tablename__ = "site_settings"

    id = Column(Integer, primary_key=True, index=True)

    grid_emission_factor_kg_per_kwh = Column(Float, nullable=False, default=0.710)
    emission_factor_source = Column(
        String,
        nullable=False,
        default="CEA CO2 Baseline Database v21.0, FY2024-25 all-India weighted average (0.710 tCO2/MWh)",
    )

    installed_it_capacity_kw = Column(Float, nullable=True)
    renewable_energy_factor = Column(Float, nullable=True)   # fraction 0..1 of facility energy
    energy_reuse_factor = Column(Float, nullable=True)       # fraction 0..1 of facility energy

    telemetry_simulated = Column(Boolean, nullable=False, default=True)

    updated_at = Column(DateTime, default=datetime.utcnow)


class Preferences(Base):
    """
    Organization-configurable weights for ranking recommendations. Single
    row (id=1 by convention) -- see rules_engine/recommendations for how
    these combine impact and risk into one score.
    """
    __tablename__ = "preferences"

    id = Column(Integer, primary_key=True, index=True)

    energy_weight = Column(Float, default=1.0)
    cost_weight = Column(Float, default=1.0)
    carbon_weight = Column(Float, default=1.0)
    water_weight = Column(Float, default=0.5)
    risk_weight = Column(Float, default=1.0)

    updated_at = Column(DateTime, default=datetime.utcnow)