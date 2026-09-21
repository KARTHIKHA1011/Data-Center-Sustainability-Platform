"""
GreenOps Phase 1 -- Observability & Resource Intelligence Foundation

Covers:
  - Ingestion for all 4 telemetry domains (server, power, cooling, storage)
  - PUE / WUE / energy / cost computed live (no ML needed)
  - Rule-based flags: idle servers, stale/duplicate/over-provisioned storage
  - Historical analytics endpoints
  - CPU-estimation ML model (validation layer) + evaluation metrics endpoint

Run:
    uvicorn app.main:app --reload --env-file .env
"""
import json
import os
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Optional

# Load .env before anything reads os.getenv()
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

import joblib
import pandas as pd
from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from sqlalchemy import func

from . import (
    models,
    schemas,
    rules_engine,
    forecasting,
    recommendations,
    compliance,
)
from .database import engine, get_db, Base
from .auth import (
    get_current_user,
    require_role,
    verify_password,
    create_access_token,
)

Base.metadata.create_all(bind=engine)

app = FastAPI(title="GreenOps Phase 1 API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Authentication routes
# ---------------------------------------------------------------------------

@app.post("/auth/login", response_model=schemas.TokenOut)
def login(payload: schemas.LoginIn, db: Session = Depends(get_db)):
    """
    Authenticate with email + password.
    Returns a JWT access token on success; 401 on invalid credentials.
    """
    user = db.query(models.User).filter(
        models.User.email == payload.email.lower().strip()
    ).first()

    if user is None or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = create_access_token(user.id, user.role, user.name)
    return {
        "access_token": token,
        "token_type": "bearer",
        "user_id": user.id,
        "name": user.name,
        "role": user.role,
    }


@app.get("/auth/me", response_model=schemas.UserOut)
def me(current_user: models.User = Depends(get_current_user)):
    """Return the currently authenticated user's profile."""
    return current_user


# ---------------------------------------------------------------------------
# User management (infrastructure_manager only)
# ---------------------------------------------------------------------------

def _user_to_dict(u: models.User) -> dict:
    return {
        "id": u.id,
        "employee_id": u.employee_id,
        "name": u.name,
        "email": u.email,
        "role": u.role,
        "is_active": u.is_active,
        "created_at": u.created_at.isoformat(),
    }


@app.get("/users")
def list_users(
    db: Session = Depends(get_db),
    _: models.User = Depends(require_role("infrastructure_manager")),
):
    """Return all users. Infrastructure Manager only."""
    users = db.query(models.User).order_by(models.User.created_at.asc()).all()
    return [_user_to_dict(u) for u in users]


@app.post("/users", status_code=201)
def create_user(
    payload: schemas.UserCreateIn,
    db: Session = Depends(get_db),
    _: models.User = Depends(require_role("infrastructure_manager")),
):
    """Create a new GreenOps user. Infrastructure Manager only."""
    from .auth import hash_password, ROLES

    # Validate role
    if payload.role not in ROLES:
        raise HTTPException(status_code=422, detail=f"Invalid role. Must be one of: {', '.join(sorted(ROLES))}")

    # Check email uniqueness
    if db.query(models.User).filter(models.User.email == payload.email.lower().strip()).first():
        raise HTTPException(status_code=409, detail="A user with this email already exists.")

    # Check employee_id uniqueness if provided
    if payload.employee_id:
        if db.query(models.User).filter(models.User.employee_id == payload.employee_id.strip()).first():
            raise HTTPException(status_code=409, detail="A user with this employee ID already exists.")

    user = models.User(
        employee_id=payload.employee_id.strip() if payload.employee_id else None,
        name=payload.name.strip(),
        email=payload.email.lower().strip(),
        password_hash=hash_password(payload.password),
        role=payload.role,
        is_active=payload.is_active,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return _user_to_dict(user)


@app.patch("/users/{user_id}")
def update_user(
    user_id: int,
    payload: schemas.UserUpdateIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_role("infrastructure_manager")),
):
    """Update a user's details or role. Infrastructure Manager only."""
    from .auth import hash_password, ROLES

    user = db.query(models.User).filter(models.User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")

    if payload.employee_id is not None:
        emp_id = payload.employee_id.strip() if payload.employee_id else None
        if emp_id:
            conflict = db.query(models.User).filter(
                models.User.employee_id == emp_id,
                models.User.id != user_id,
            ).first()
            if conflict:
                raise HTTPException(status_code=409, detail="Employee ID already in use.")
        user.employee_id = emp_id

    if payload.name is not None:
        user.name = payload.name.strip()

    if payload.email is not None:
        new_email = payload.email.lower().strip()
        conflict = db.query(models.User).filter(
            models.User.email == new_email,
            models.User.id != user_id,
        ).first()
        if conflict:
            raise HTTPException(status_code=409, detail="Email already in use.")
        user.email = new_email

    if payload.password is not None:
        user.password_hash = hash_password(payload.password)

    if payload.role is not None:
        if payload.role not in ROLES:
            raise HTTPException(status_code=422, detail=f"Invalid role.")
        user.role = payload.role

    if payload.is_active is not None:
        user.is_active = payload.is_active

    db.commit()
    db.refresh(user)
    return _user_to_dict(user)


@app.delete("/users/{user_id}", status_code=204)
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_role("infrastructure_manager")),
):
    """Deactivate (soft-delete) a user. Infrastructure Manager only."""
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot deactivate your own account.")
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    user.is_active = False
    db.commit()

TARIFF_PER_KWH = 8.0          # placeholder tariff, currency-agnostic
# Grid emission factor is no longer a constant here: every carbon figure reads
# compliance.emission_factor(db), the configurable, sourced value in site_settings.
WUE_WINDOW_HOURS = 1          # window for the WUE *rate* (L/kWh) -- keeps it a stable ratio, not a running total

MODEL_DIR = os.path.join(os.path.dirname(__file__), "ml_artifacts")
CPU_MODEL_PATH = os.path.join(MODEL_DIR, "cpu_model.joblib")
POWER_MODEL_PATH = os.path.join(MODEL_DIR, "power_model.joblib")
METRICS_PATH = os.path.join(MODEL_DIR, "metrics.json")

_cpu_model = joblib.load(CPU_MODEL_PATH) if os.path.exists(CPU_MODEL_PATH) else None
_power_model = joblib.load(POWER_MODEL_PATH) if os.path.exists(POWER_MODEL_PATH) else None


# ---------------------------------------------------------------------------
# Server registration
# ---------------------------------------------------------------------------

@app.post("/servers/register")
def register_server(payload: schemas.ServerRegisterIn, db: Session = Depends(get_db)):
    existing = db.query(models.Server).filter(models.Server.server_id == payload.server_id).first()
    if existing:
        return {"status": "already_registered", "server_id": payload.server_id}
    server = models.Server(**payload.dict())
    db.add(server)
    db.commit()
    return {"status": "registered", "server_id": payload.server_id}


# ---------------------------------------------------------------------------
# Telemetry ingestion (4 domains)
# ---------------------------------------------------------------------------

DUPLICATE_WINDOW_SECONDS = 2  # simulators post every 15-30s; anything faster than this repeating the exact same values is a retried delivery, not a new reading


def _is_duplicate_reading(db: Session, model, server_id: str, payload: dict, compare_fields: list) -> bool:
    """
    Idempotency check for telemetry ingest: the same server posting the
    exact same field values again within DUPLICATE_WINDOW_SECONDS is treated
    as a retried delivery (e.g. a network retry), not a genuinely new
    reading, and is silently ignored rather than double-counted.
    """
    latest = _latest(db, model, server_id)
    if latest is None:
        return False
    if (datetime.utcnow() - latest.timestamp).total_seconds() > DUPLICATE_WINDOW_SECONDS:
        return False
    return all(getattr(latest, field) == payload.get(field) for field in compare_fields)


@app.post("/telemetry/server")
def ingest_server(payload: schemas.ServerTelemetryIn, db: Session = Depends(get_db)):
    data = payload.dict()
    if _is_duplicate_reading(
        db, models.ServerTelemetry, payload.server_id, data,
        ["cpu_utilization", "memory_utilization", "network_throughput_gbps", "workload_intensity"],
    ):
        return {"status": "duplicate_ignored"}
    row = models.ServerTelemetry(**data)
    db.add(row)
    db.commit()
    rules_engine.check_idle_server(db, payload.server_id)
    return {"status": "ok"}


@app.post("/telemetry/power")
def ingest_power(payload: schemas.PowerTelemetryIn, db: Session = Depends(get_db)):
    data = payload.dict()
    if _is_duplicate_reading(
        db, models.PowerTelemetry, payload.server_id, data,
        ["it_power_kw", "facility_power_kw"],
    ):
        return {"status": "duplicate_ignored"}
    row = models.PowerTelemetry(**data)
    db.add(row)
    db.commit()
    return {"status": "ok"}


@app.post("/telemetry/cooling")
def ingest_cooling(payload: schemas.CoolingTelemetryIn, db: Session = Depends(get_db)):
    data = payload.dict()
    if _is_duplicate_reading(
        db, models.CoolingTelemetry, payload.server_id, data,
        ["inlet_temperature_c", "cooling_efficiency", "cooling_type"],
    ):
        return {"status": "duplicate_ignored"}
    row = models.CoolingTelemetry(**data)
    db.add(row)
    db.commit()
    return {"status": "ok"}


@app.post("/telemetry/storage")
def ingest_storage(payload: schemas.StorageTelemetryIn, db: Session = Depends(get_db)):
    data = payload.dict()
    if _is_duplicate_reading(
        db, models.StorageTelemetry, payload.server_id, data,
        ["total_storage_gb", "used_storage_gb", "duplicate_data_gb", "last_accessed_days_ago", "storage_type"],
    ):
        return {"status": "duplicate_ignored"}
    row = models.StorageTelemetry(**data)
    db.add(row)
    db.commit()
    rules_engine.check_storage(db, row)
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Servers overview
# ---------------------------------------------------------------------------

def _latest(db: Session, model, server_id: str):
    return (
        db.query(model)
        .filter(model.server_id == server_id)
        .order_by(model.timestamp.desc())
        .first()
    )


def _latest_row_per_server(db: Session, model):
    """
    The latest row per server_id for a telemetry model, in one query -- for
    aggregating a "current snapshot" value (e.g. total storage capacity)
    across servers. Summing a telemetry column directly with func.sum()
    double-, triple-, N-counts it: every server reposts the same reading
    over and over, so a plain SUM grows with however many readings have
    accumulated, not with anything real.
    """
    latest_ts = (
        db.query(model.server_id, func.max(model.timestamp).label("max_ts"))
        .group_by(model.server_id)
        .subquery()
    )
    return (
        db.query(model)
        .join(latest_ts, (model.server_id == latest_ts.c.server_id) & (model.timestamp == latest_ts.c.max_ts))
        .all()
    )


@app.get("/servers")
def list_servers(db: Session = Depends(get_db)):
    servers = db.query(models.Server).all()
    out = []
    idle_cutoff = datetime.utcnow() - timedelta(hours=rules_engine.IDLE_LOOKBACK_HOURS)
    for s in servers:
        latest_server = _latest(db, models.ServerTelemetry, s.server_id)
        latest_power = _latest(db, models.PowerTelemetry, s.server_id)
        latest_cooling = _latest(db, models.CoolingTelemetry, s.server_id)

        # Matches rules_engine.check_idle_server exactly: same lookback window,
        # same threshold source. The state badge must agree with the flag that
        # actually gets raised, not with the instantaneous CPU reading.
        avg_cpu = (
            db.query(func.avg(models.ServerTelemetry.cpu_utilization))
            .filter(
                models.ServerTelemetry.server_id == s.server_id,
                models.ServerTelemetry.timestamp >= idle_cutoff,
            )
            .scalar()
        )

        # "No Data" = never posted anything, ever. "Stale" = has posted
        # before, but nothing in the last IDLE_LOOKBACK_HOURS -- distinct
        # from "Healthy", which claims recent telemetry actually looks
        # fine. Without this, a server that stopped reporting hours ago
        # (avg_cpu is None because the windowed query finds nothing) fell
        # through to the same "Healthy" label as a server confirmed fine
        # right now -- silently indistinguishable from each other.
        state = "No Data"
        cpu_val = None
        if latest_server:
            cpu_val = latest_server.cpu_utilization
            if avg_cpu is None:
                state = "Stale"
            else:
                threshold = rules_engine.get_idle_threshold(s.server_type)
                state = "Underutilized" if avg_cpu < threshold else "Healthy"

        out.append({
            "server_id": s.server_id,
            "server_type": s.server_type,
            "cooling_type": s.cooling_type,
            "region": s.datacenter_region,
            "cpu": cpu_val,
            "memory": latest_server.memory_utilization if latest_server else None,
            "network_gbps": latest_server.network_throughput_gbps if latest_server else None,
            "avg_cpu": round(avg_cpu, 2) if avg_cpu else None,
            "it_power_kw": latest_power.it_power_kw if latest_power else None,
            "facility_power_kw": latest_power.facility_power_kw if latest_power else None,
            # cooling_efficiency exposed here (not just on /servers/{id}/detail) so
            # power_monitor.py can read it in the same bulk GET /servers call it
            # already makes for CPU/memory, without an extra per-server request --
            # see power_monitor.py's overhead_ratio, which now derives PUE from
            # this instead of a random draw.
            "cooling_efficiency": latest_cooling.cooling_efficiency if latest_cooling else None,
            "state": state,
        })
    return out


@app.get("/servers/{server_id}/history")
def server_history(server_id: str, hours: int = 24, db: Session = Depends(get_db)):
    cutoff = datetime.utcnow() - timedelta(hours=hours)
    rows = (
        db.query(models.ServerTelemetry)
        .filter(models.ServerTelemetry.server_id == server_id, models.ServerTelemetry.timestamp >= cutoff)
        .order_by(models.ServerTelemetry.timestamp.asc())
        .all()
    )
    return [
        {
            "timestamp": r.timestamp.isoformat(),
            "cpu": r.cpu_utilization,
            "memory": r.memory_utilization,
            "network_gbps": r.network_throughput_gbps,
            "workload": r.workload_intensity,
        }
        for r in rows
    ]


@app.get("/servers/{server_id}/detail")
def server_detail(server_id: str, db: Session = Depends(get_db)):
    """
    Everything about a single server beyond its CPU history: latest cooling
    and power readings, latest storage telemetry (null if this server has
    none -- not every type necessarily reports storage), and the flags
    currently active for this specific server. Powers the Server Detail
    page's vitals strip, Cooling & Power section, Storage section, and
    per-server flag list.
    """
    server = db.query(models.Server).filter(models.Server.server_id == server_id).first()
    if server is None:
        raise HTTPException(status_code=404, detail="Server not registered")

    latest_cooling = _latest(db, models.CoolingTelemetry, server_id)
    latest_power = _latest(db, models.PowerTelemetry, server_id)
    latest_storage = _latest(db, models.StorageTelemetry, server_id)

    flags = (
        db.query(models.Flag)
        .filter(models.Flag.server_id == server_id, models.Flag.resolved == 0)
        .order_by(models.Flag.created_at.desc())
        .all()
    )

    per_server_pue = None
    if latest_power and latest_power.it_power_kw:
        per_server_pue = rules_engine.compute_pue(latest_power.it_power_kw, latest_power.facility_power_kw)

    return {
        "server_id": server_id,
        "server_type": server.server_type,
        "region": server.datacenter_region,
        "emission_factor_kg_per_kwh": compliance.emission_factor(db),
        "power": {
            "it_power_kw": latest_power.it_power_kw,
            "facility_power_kw": latest_power.facility_power_kw,
            "pue": per_server_pue,
        } if latest_power else None,
        "cooling": {
            "inlet_temperature_c": latest_cooling.inlet_temperature_c,
            "cooling_efficiency": latest_cooling.cooling_efficiency,
            "cooling_type": latest_cooling.cooling_type,
        } if latest_cooling else None,
        "storage": {
            "total_storage_gb": latest_storage.total_storage_gb,
            "used_storage_gb": latest_storage.used_storage_gb,
            "duplicate_data_gb": latest_storage.duplicate_data_gb,
            "last_accessed_days_ago": latest_storage.last_accessed_days_ago,
            "storage_type": latest_storage.storage_type,
        } if latest_storage else None,
        "flags": [
            {
                "flag_type": f.flag_type,
                "severity": f.severity,
                "detail": f.detail,
                "metric_value": f.metric_value,
                "created_at": f.created_at.isoformat(),
            }
            for f in flags
        ],
    }


@app.get("/servers/{server_id}/prediction")
def server_prediction(server_id: str, db: Session = Depends(get_db)):
    """Compares the live measured CPU against the ML model's contextual estimate."""
    if _cpu_model is None:
        raise HTTPException(status_code=503, detail="CPU model not trained yet. Run train_model.py first.")

    latest_server = _latest(db, models.ServerTelemetry, server_id)
    latest_cooling = _latest(db, models.CoolingTelemetry, server_id)
    latest_power = _latest(db, models.PowerTelemetry, server_id)
    server_meta = db.query(models.Server).filter(models.Server.server_id == server_id).first()

    if not (latest_server and latest_cooling and latest_power and server_meta):
        raise HTTPException(status_code=404, detail="Not enough telemetry yet for this server.")

    pue = rules_engine.compute_pue(latest_power.it_power_kw, latest_power.facility_power_kw)

    features = pd.DataFrame([{
        "workload_intensity": latest_server.workload_intensity,
        "memory_utilization": latest_server.memory_utilization,
        "network_throughput_gbps": latest_server.network_throughput_gbps,
        "inlet_temperature_c": latest_cooling.inlet_temperature_c,
        "cooling_efficiency": latest_cooling.cooling_efficiency,
        "pue": pue,
        "server_type": server_meta.server_type,
        "cooling_type": server_meta.cooling_type,
        "datacenter_region": server_meta.datacenter_region,
        "time_of_day": rules_engine.get_time_of_day(latest_server.timestamp),
    }])

    predicted_cpu = float(_cpu_model.predict(features)[0])
    measured_cpu = latest_server.cpu_utilization

    result = {
        "server_id": server_id,
        "measured_cpu": round(measured_cpu, 2),
        "predicted_cpu": round(predicted_cpu, 2),
        "absolute_error": round(abs(predicted_cpu - measured_cpu), 2),
    }

    if _power_model is not None:
        power_features = features.copy()
        power_features["cpu_utilization"] = measured_cpu  # power model takes CPU as an input
        predicted_power = float(_power_model.predict(power_features)[0])
        result["predicted_power_kw"] = round(predicted_power, 2)
        result["measured_it_power_kw"] = latest_power.it_power_kw

    return result


@app.get("/servers/{server_id}/forecast")
def server_forecast(server_id: str, horizon_minutes: int = 60, db: Session = Depends(get_db)):
    """Forecast near-term CPU/workload only for idle or underutilized servers."""
    if horizon_minutes not in forecasting.OPERATOR_HORIZONS:
        raise HTTPException(
            status_code=422,
            detail=f"horizon_minutes must be one of {forecasting.OPERATOR_HORIZONS} (60=1h, 360=6h, 1440=24h)",
        )

    server = db.query(models.Server).filter(models.Server.server_id == server_id).first()
    if server is None:
        raise HTTPException(status_code=404, detail="Server not registered")

    result = forecasting.forecast_server(db, server_id, horizon_minutes=horizon_minutes)
    if not result.get("eligible"):
        return result

    record = models.Forecast(
        server_id=result["server_id"],
        horizon_minutes=result["horizon_minutes"],
        measured_cpu=result["measured_cpu"],
        predicted_cpu=result["predicted_cpu"],
        method=result["method"],
        model_version=result.get("model_version"),
        validation_mae=result.get("validation_mae"),
        validation_rmse=result.get("validation_rmse"),
        validation_r2=result.get("validation_r2"),
        source_observations=result.get("source_observations", 0),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    result["forecast_id"] = record.id
    return result


@app.get("/forecasts")
def list_forecasts(server_id: Optional[str] = None, limit: int = 50, db: Session = Depends(get_db)):
    """Return the most recent persisted forecast records for audit/drill-down views."""
    limit = max(1, min(limit, 200))
    query = db.query(models.Forecast)
    if server_id and server_id != "all":
        query = query.filter(models.Forecast.server_id == server_id)
    rows = query.order_by(models.Forecast.generated_at.desc()).limit(limit).all()
    return [
        {
            "id": row.id,
            "server_id": row.server_id,
            "horizon_minutes": row.horizon_minutes,
            "measured_cpu": row.measured_cpu,
            "predicted_cpu": row.predicted_cpu,
            "delta_cpu_pp": round(row.predicted_cpu - row.measured_cpu, 2),
            "method": row.method,
            "model_version": row.model_version,
            "validation_mae": row.validation_mae,
            "validation_rmse": row.validation_rmse,
            "validation_r2": row.validation_r2,
            "source_observations": row.source_observations,
            "generated_at": row.generated_at.isoformat(),
        }
        for row in rows
    ]


# ---------------------------------------------------------------------------
# Storage optimization
# ---------------------------------------------------------------------------

@app.get("/storage/flags")
def storage_flags(db: Session = Depends(get_db)):
    rows = (
        db.query(models.Flag)
        .filter(models.Flag.flag_type.in_(["stale_data", "duplicate_data", "overprovisioned"]))
        .filter(models.Flag.resolved == 0)
        .order_by(models.Flag.created_at.desc())
        .all()
    )
    return [
        {
            "server_id": r.server_id,
            "flag_type": r.flag_type,
            "severity": r.severity,
            "detail": r.detail,
            "metric_value_gb": r.metric_value,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]



# ---------------------------------------------------------------------------
# Recommendations
# ---------------------------------------------------------------------------

@app.get("/recommendations")
def list_recommendations(
    include_completed: bool = False,
    db: Session = Depends(get_db),
):
    """
    Return operator-facing recommendations generated from active rule-based
    flags, ranked by a weighted score (see /preferences) that combines each
    recommendation's estimated impact against its risk.
    """

    ranked = recommendations.get_recommendations(
        db,
        include_completed=include_completed,
        power_model=_power_model,
    )

    out = []
    for entry in ranked:
        row = entry["recommendation"]
        impact = entry["impact"]
        out.append({
            "id": row.id,
            "flag_id": row.flag_id,
            "server_id": row.server_id,
            "recommendation_type": row.recommendation_type,
            "priority": row.priority,
            "explanation": row.explanation,
            "status": row.status,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "decided_at": row.decided_at.isoformat() if row.decided_at else None,
            "snoozed_until": row.snoozed_until.isoformat() if row.snoozed_until else None,
            "score": entry["score"],
            "impact": impact,
        })
    return out


@app.get("/recommendations/{recommendation_id}")
def get_recommendation(recommendation_id: int, db: Session = Depends(get_db)):
    """
    A single recommendation plus its full what-if impact (including every
    consolidation candidate considered, not just the winner) -- powers the
    Recommendations detail view so it doesn't need the whole list just to
    show one item.
    """
    row = db.query(models.Recommendation).filter(models.Recommendation.id == recommendation_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Recommendation not found.")

    impact = recommendations.calculate_what_if(db, row, power_model=_power_model)

    return {
        "id": row.id,
        "flag_id": row.flag_id,
        "server_id": row.server_id,
        "recommendation_type": row.recommendation_type,
        "priority": row.priority,
        "explanation": row.explanation,
        "status": row.status,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "decided_at": row.decided_at.isoformat() if row.decided_at else None,
        "snoozed_until": row.snoozed_until.isoformat() if row.snoozed_until else None,
        "impact": impact,
    }


@app.get("/recommendations/{recommendation_id}/what-if")
def recommendation_what_if(
    recommendation_id: int,
    db: Session = Depends(get_db),
):
    """
    Calculate the estimated impact of applying a recommendation. For
    consolidation, this runs a real target-candidate simulation (see
    recommendations._find_consolidation_target) -- not just a source-server
    estimate.
    """

    recommendation = (
        db.query(models.Recommendation)
        .filter(
            models.Recommendation.id ==
            recommendation_id
        )
        .first()
    )

    if recommendation is None:
        raise HTTPException(
            status_code=404,
            detail="Recommendation not found.",
        )

    return recommendations.calculate_what_if(
        db,
        recommendation,
        power_model=_power_model,
    )


@app.post("/recommendations/{recommendation_id}/action")
def recommendation_action(
    recommendation_id: int,
    payload: schemas.OperatorActionIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_role("infrastructure_manager")),
):
    """
    Record the operator's decision.

    RBAC: infrastructure_manager only. Returns 403 for all other roles.
    This does NOT actually modify infrastructure.
    """

    recommendation = (
        db.query(models.Recommendation)
        .filter(
            models.Recommendation.id ==
            recommendation_id
        )
        .first()
    )

    if recommendation is None:
        raise HTTPException(
            status_code=404,
            detail="Recommendation not found.",
        )

    try:

        action = recommendations.record_operator_action(
            db,
            recommendation,
            payload.action,
            payload.notes,
            snooze_hours=payload.snooze_hours or 24,
            power_model=_power_model,
        )

    except ValueError as exc:

        raise HTTPException(
            status_code=400,
            detail=str(exc),
        )

    # Audit trail: stamp who made the decision
    action.decided_by_user_id = current_user.id
    action.decided_by_name    = current_user.name
    action.decided_by_role    = current_user.role
    db.commit()

    return {
        "status": "recorded",
        "recommendation_id": recommendation.id,
        "server_id": recommendation.server_id,
        "action": action.action,
        "recommendation_status": recommendation.status,
        "snoozed_until": recommendation.snoozed_until.isoformat() if recommendation.snoozed_until else None,
        "decided_by": current_user.name,
        "message": (
            "Operator decision recorded. "
            "No physical infrastructure change was performed."
        ),
    }


# ---------------------------------------------------------------------------
# Preferences -- ranking weights
# ---------------------------------------------------------------------------

@app.get("/preferences")
def get_preferences(db: Session = Depends(get_db)):
    prefs = recommendations.get_preferences(db)
    return {
        "energy_weight": prefs.energy_weight,
        "cost_weight": prefs.cost_weight,
        "carbon_weight": prefs.carbon_weight,
        "water_weight": prefs.water_weight,
        "risk_weight": prefs.risk_weight,
        "updated_at": prefs.updated_at.isoformat() if prefs.updated_at else None,
    }


@app.put("/preferences")
def update_preferences(
    payload: schemas.PreferencesIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_role("infrastructure_manager")),
):
    prefs = recommendations.get_preferences(db)
    prefs.energy_weight = payload.energy_weight
    prefs.cost_weight = payload.cost_weight
    prefs.carbon_weight = payload.carbon_weight
    prefs.water_weight = payload.water_weight
    prefs.risk_weight = payload.risk_weight
    prefs.updated_at = datetime.utcnow()
    db.commit()
    return {"status": "updated"}


@app.get("/operator-actions")
def operator_actions(
    limit: int = 50,
    db: Session = Depends(get_db),
):

    limit = max(1, min(limit, 200))

    rows = (
        db.query(models.OperatorAction)
        .order_by(
            models.OperatorAction.created_at.desc()
        )
        .limit(limit)
        .all()
    )

    return [
        {
            "id": row.id,
            "recommendation_id": row.recommendation_id,
            "server_id": row.server_id,
            "target_server_id": row.target_server_id,
            "action": row.action,
            "notes": row.notes,
            "estimated_energy_saving_kwh": row.estimated_energy_saving_kwh,
            "estimated_carbon_reduction_kg": row.estimated_carbon_reduction_kg,
            "estimated_cost_saving": row.estimated_cost_saving,
            "estimated_storage_reclaimed_gb": row.estimated_storage_reclaimed_gb,
            "created_at": row.created_at.isoformat(),
            "executed_at": row.executed_at.isoformat() if row.executed_at else None,
            "execution_note": row.execution_note,
            "decided_by_name": row.decided_by_name,
            "decided_by_role": row.decided_by_role,
        }
        for row in rows
    ]


@app.patch("/operator-actions/{action_id}")
def update_operator_action(
    action_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_role("infrastructure_manager", "operations_engineer")),
):
    """
    Mark an approved operator action as executed (or clear execution).

    RBAC: infrastructure_manager and operations_engineer.
    Accepts JSON body: { "executed": true/false, "execution_note": "..." }
    """
    row = db.query(models.OperatorAction).filter(models.OperatorAction.id == action_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Operator action not found.")

    if "executed" in payload:
        row.executed_at = datetime.utcnow() if payload["executed"] else None

    if "execution_note" in payload:
        row.execution_note = payload.get("execution_note") or None

    db.commit()
    return {
        "id": row.id,
        "executed_at": row.executed_at.isoformat() if row.executed_at else None,
        "execution_note": row.execution_note,
    }


@app.get("/flags")
def all_flags(db: Session = Depends(get_db)):
    rows = (
        db.query(models.Flag)
        .filter(models.Flag.resolved == 0)
        .order_by(models.Flag.created_at.desc())
        .all()
    )
    return [
        {
            "server_id": r.server_id,
            "flag_type": r.flag_type,
            "severity": r.severity,
            "detail": r.detail,
            "metric_value": r.metric_value,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Analytics / sustainability overview (PUE, WUE, energy, cost -- pure math)
# ---------------------------------------------------------------------------

@app.get("/analytics/summary")
def analytics_summary(db: Session = Depends(get_db)):
    avg_cpu = db.query(func.avg(models.ServerTelemetry.cpu_utilization)).scalar() or 0
    avg_memory = db.query(func.avg(models.ServerTelemetry.memory_utilization)).scalar() or 0

    total_it_power = db.query(func.sum(models.PowerTelemetry.it_power_kw)).scalar() or 0
    total_facility_power = db.query(func.sum(models.PowerTelemetry.facility_power_kw)).scalar() or 0
    power_readings = db.query(func.count(models.PowerTelemetry.id)).scalar() or 1

    avg_it_power = total_it_power / power_readings
    avg_facility_power = total_facility_power / power_readings
    pue = rules_engine.compute_pue(avg_it_power, avg_facility_power)

    # True energy integration over actual reading timestamps, broken out per
    # server (see rules_engine.compute_energy_by_server) -- cumulative since
    # telemetry began, not scoped to a fixed window.
    energy_by_server = rules_engine.compute_energy_by_server(db)
    energy_kwh = round(sum(energy_by_server.values()), 4)
    cost = round(energy_kwh * TARIFF_PER_KWH, 2)
    emission_factor = compliance.emission_factor(db)
    carbon_kg = round(energy_kwh * emission_factor, 2)

    # Weighted by each server's OWN cooling type and its own share of energy
    # use -- not by whichever single cooling reading happened to post last
    # across the whole facility (servers here use three different cooling
    # types, with WUE factors up to 6x apart, so a single "representative"
    # type would swing the number depending on refresh timing alone).
    cooling_type_by_server = dict(db.query(models.Server.server_id, models.Server.cooling_type).all())
    total_water_l = rules_engine.compute_wue_liters_weighted(energy_by_server, cooling_type_by_server)

    # WUE itself is a RATE (liters per kWh), not a running total -- computing
    # it over "all energy since telemetry began" would make it climb forever
    # even once the system is at steady state. Windowed so it actually
    # stabilizes; reported separately from the cumulative water total above.
    wue = rules_engine.compute_wue_rate(db, window_hours=WUE_WINDOW_HOURS)

    # Latest reading per server only -- see _latest_row_per_server. Storage
    # capacity is reposted unchanged every ~30s; a plain SUM across all
    # historical rows inflates "current" totals by however many readings
    # have accumulated, not by anything real.
    latest_storage_rows = _latest_row_per_server(db, models.StorageTelemetry)
    total_storage = sum(r.total_storage_gb for r in latest_storage_rows)

    stale_server_ids = {
        row[0] for row in db.query(models.Flag.server_id)
        .filter(models.Flag.flag_type == "stale_data", models.Flag.resolved == 0)
        .all()
    }
    stale_gb = sum(r.used_storage_gb for r in latest_storage_rows if r.server_id in stale_server_ids)

    return {
        "avg_cpu": round(avg_cpu, 2),
        "avg_memory": round(avg_memory, 2),
        "avg_it_power_kw": round(avg_it_power, 2),
        "avg_facility_power_kw": round(avg_facility_power, 2),
        "pue": pue,
        "estimated_energy_kwh": round(energy_kwh, 2),
        "estimated_cost": cost,
        "estimated_carbon_kg": carbon_kg,
        "emission_factor_kg_per_kwh": emission_factor,
        "total_water_l": total_water_l,
        "wue_l_per_kwh": wue["rate_l_per_kwh"],
        "wue_window_hours": wue["window_hours"],
        "total_storage_gb": round(total_storage, 2),
        "stale_storage_gb": round(stale_gb, 2),
        "active_flags": db.query(func.count(models.Flag.id)).filter(models.Flag.resolved == 0).scalar(),
    }


def _safe_average(values):
    return round(sum(values) / len(values), 2) if values else None


def _integrate_daily_energy(power_rows):
    """Integrate facility power by server and UTC calendar day.

    Energy comes only from adjacent recorded readings. Intervals crossing
    midnight or exceeding the five-minute gap guard are not assigned to a day,
    which prevents invented energy when a simulator is stopped.
    """
    by_server = defaultdict(list)
    for row in power_rows:
        by_server[row.server_id].append(row)

    energy = defaultdict(float)
    for server_id, rows in by_server.items():
        rows.sort(key=lambda row: row.timestamp)
        for previous, current in zip(rows, rows[1:]):
            if previous.timestamp.date() != current.timestamp.date():
                continue
            hours = (current.timestamp - previous.timestamp).total_seconds() / 3600.0
            if 0 < hours <= rules_engine.MAX_INTERVAL_HOURS:
                energy[(current.timestamp.date().isoformat(), server_id)] += previous.facility_power_kw * hours
    return energy


@app.get("/analytics/daily")
def analytics_daily(
    days: int = 7,
    server_id: Optional[str] = None,
    region: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Return a daily operational ledger for the selected calendar window.

    The default is the past seven UTC calendar days. Optional server and region
    filters are applied across all telemetry domains. Empty days are returned as
    ``no_data`` rather than filled with synthetic values.
    """
    days = max(1, min(days, 31))
    emission_factor = compliance.emission_factor(db)
    today = datetime.utcnow().date()
    start_date = today - timedelta(days=days - 1)
    cutoff = datetime.combine(start_date, datetime.min.time())

    server_query = db.query(models.Server)
    if region and region != "all":
        server_query = server_query.filter(models.Server.datacenter_region == region)
    if server_id and server_id != "all":
        server_query = server_query.filter(models.Server.server_id == server_id)

    server_meta_rows = server_query.all()
    allowed_server_ids = {row.server_id for row in server_meta_rows}
    metadata = {
        row.server_id: {
            "server_type": row.server_type,
            "cooling_type": row.cooling_type,
            "region": row.datacenter_region,
        }
        for row in server_meta_rows
    }

    def in_scope(query, model):
        query = query.filter(model.timestamp >= cutoff)
        if allowed_server_ids:
            query = query.filter(model.server_id.in_(allowed_server_ids))
        else:
            query = query.filter(model.server_id == "__no_matching_server__")
        return query.order_by(model.timestamp.asc()).all()

    server_rows = in_scope(db.query(models.ServerTelemetry), models.ServerTelemetry)
    power_rows = in_scope(db.query(models.PowerTelemetry), models.PowerTelemetry)
    cooling_rows = in_scope(db.query(models.CoolingTelemetry), models.CoolingTelemetry)
    storage_rows = in_scope(db.query(models.StorageTelemetry), models.StorageTelemetry)
    energy_by_day_server = _integrate_daily_energy(power_rows)

    day_data = {
        (start_date + timedelta(days=index)).isoformat(): {
            "server": defaultdict(lambda: {"cpu": [], "memory": [], "network": [], "workload": []}),
            "power": defaultdict(lambda: {"it": [], "facility": []}),
            "cooling": defaultdict(lambda: {"temperature": [], "efficiency": [], "types": []}),
            "storage": defaultdict(lambda: {"total": [], "used": [], "duplicate": []}),
            "counts": {"server": 0, "power": 0, "cooling": 0, "storage": 0},
        }
        for index in range(days)
    }

    for row in server_rows:
        bucket = day_data[row.timestamp.date().isoformat()]
        values = bucket["server"][row.server_id]
        values["cpu"].append(row.cpu_utilization)
        values["memory"].append(row.memory_utilization)
        values["network"].append(row.network_throughput_gbps)
        values["workload"].append(row.workload_intensity)
        bucket["counts"]["server"] += 1

    for row in power_rows:
        bucket = day_data[row.timestamp.date().isoformat()]
        values = bucket["power"][row.server_id]
        values["it"].append(row.it_power_kw)
        values["facility"].append(row.facility_power_kw)
        bucket["counts"]["power"] += 1

    for row in cooling_rows:
        bucket = day_data[row.timestamp.date().isoformat()]
        values = bucket["cooling"][row.server_id]
        values["temperature"].append(row.inlet_temperature_c)
        values["efficiency"].append(row.cooling_efficiency)
        values["types"].append(row.cooling_type)
        bucket["counts"]["cooling"] += 1

    for row in storage_rows:
        bucket = day_data[row.timestamp.date().isoformat()]
        values = bucket["storage"][row.server_id]
        values["total"].append(row.total_storage_gb)
        values["used"].append(row.used_storage_gb)
        values["duplicate"].append(row.duplicate_data_gb)
        bucket["counts"]["storage"] += 1

    daily = []
    for date_string, bucket in day_data.items():
        count = bucket["counts"]
        observed_domains = [name for name, value in count.items() if value > 0]
        status = "complete" if len(observed_domains) == 4 else "partial" if observed_domains else "no_data"
        all_cpu = [value for values in bucket["server"].values() for value in values["cpu"]]
        all_memory = [value for values in bucket["server"].values() for value in values["memory"]]
        all_it = [value for values in bucket["power"].values() for value in values["it"]]
        all_facility = [value for values in bucket["power"].values() for value in values["facility"]]
        all_temperature = [value for values in bucket["cooling"].values() for value in values["temperature"]]
        all_efficiency = [value for values in bucket["cooling"].values() for value in values["efficiency"]]
        day_energy = sum(value for (day, _), value in energy_by_day_server.items() if day == date_string)
        day_pue = rules_engine.compute_pue(_safe_average(all_it) or 0, _safe_average(all_facility) or 0)
        day_server_ids = set(bucket["server"]) | set(bucket["power"]) | {
            current_server_id for (day, current_server_id), value in energy_by_day_server.items()
            if day == date_string and value > 0
        }

        server_breakdown = []
        for current_server_id in sorted(day_server_ids):
            server_values = bucket["server"].get(current_server_id, {})
            power_values = bucket["power"].get(current_server_id, {})
            meta = metadata.get(current_server_id, {"server_type": "Unknown", "cooling_type": "Unknown", "region": "Unknown"})
            server_it = _safe_average(power_values.get("it", []))
            server_facility = _safe_average(power_values.get("facility", []))
            server_energy = round(energy_by_day_server.get((date_string, current_server_id), 0.0), 4)
            cooling_values = bucket["cooling"].get(current_server_id, {})
            storage_values = bucket["storage"].get(current_server_id, {})
            storage_total = storage_values.get("total", [])[-1] if storage_values.get("total") else None
            storage_used = storage_values.get("used", [])[-1] if storage_values.get("used") else None
            storage_duplicate = storage_values.get("duplicate", [])[-1] if storage_values.get("duplicate") else None
            water_factor = rules_engine.WUE_FACTORS.get(meta["cooling_type"], 0.5)
            server_breakdown.append({
                "server_id": current_server_id,
                **meta,
                "avg_cpu": _safe_average(server_values.get("cpu", [])),
                "avg_memory": _safe_average(server_values.get("memory", [])),
                "avg_network_gbps": _safe_average(server_values.get("network", [])),
                "avg_workload_intensity": _safe_average(server_values.get("workload", [])),
                "avg_it_power_kw": server_it,
                "avg_facility_power_kw": server_facility,
                "pue": rules_engine.compute_pue(server_it or 0, server_facility or 0) if server_it is not None else None,
                "avg_inlet_temperature_c": _safe_average(cooling_values.get("temperature", [])),
                "avg_cooling_efficiency": _safe_average(cooling_values.get("efficiency", [])),
                "total_storage_gb": storage_total,
                "used_storage_gb": storage_used,
                "duplicate_data_gb": storage_duplicate,
                "storage_utilization_pct": round(storage_used / storage_total * 100, 2) if storage_total else None,
                "energy_kwh": server_energy,
                "estimated_cost": round(server_energy * TARIFF_PER_KWH, 2),
                "estimated_carbon_kg": round(server_energy * emission_factor, 2),
                "estimated_water_l": round(server_energy * water_factor, 2),
                "observations": len(server_values.get("cpu", [])) + len(power_values.get("facility", [])),
            })

        daily.append({
            "date": date_string,
            "status": status,
            "observed_domains": observed_domains,
            "readings": count,
            "active_servers": len(day_server_ids),
            "avg_cpu": _safe_average(all_cpu),
            "avg_memory": _safe_average(all_memory),
            "avg_it_power_kw": _safe_average(all_it),
            "avg_facility_power_kw": _safe_average(all_facility),
            "avg_inlet_temperature_c": _safe_average(all_temperature),
            "avg_cooling_efficiency": _safe_average(all_efficiency),
            "pue": day_pue if all_it and all_facility else None,
            "energy_kwh": round(day_energy, 4),
            "estimated_cost": round(day_energy * TARIFF_PER_KWH, 2),
            "estimated_carbon_kg": round(day_energy * emission_factor, 2),
            "estimated_water_l": round(sum(item["estimated_water_l"] for item in server_breakdown), 2),
            "server_breakdown": server_breakdown,
        })

    observed_days = [row for row in daily if row["status"] != "no_data"]
    total_energy = sum(row["energy_kwh"] for row in daily)
    cpu_values = [row.cpu_utilization for row in server_rows]
    memory_values = [row.memory_utilization for row in server_rows]
    pue_values = [row["pue"] for row in daily if row["pue"] is not None]
    period_summary = {
        "observed_days": len(observed_days),
        "total_days": days,
        "total_readings": sum(sum(row["readings"].values()) for row in daily),
        "avg_cpu": _safe_average(cpu_values),
        "avg_memory": _safe_average(memory_values),
        "avg_pue": _safe_average(pue_values),
        "total_energy_kwh": round(total_energy, 2),
        "estimated_cost": round(total_energy * TARIFF_PER_KWH, 2),
        "estimated_carbon_kg": round(total_energy * emission_factor, 2),
        "peak_cpu_day": max(observed_days, key=lambda row: row["avg_cpu"] or -1)["date"] if observed_days else None,
        "peak_power_day": max(observed_days, key=lambda row: row["avg_facility_power_kw"] or -1)["date"] if observed_days else None,
    }

    return {
        "range": {"days": days, "from": start_date.isoformat(), "to": today.isoformat()},
        "filters": {"server_id": server_id or "all", "region": region or "all"},
        "period_summary": period_summary,
        "daily": daily,
    }


@app.get("/analytics/history")
def analytics_history(hours: int = 24, db: Session = Depends(get_db)):
    """Time series of fleet-wide average CPU and facility power, for charts."""
    cutoff = datetime.utcnow() - timedelta(hours=hours)
    server_rows = (
        db.query(models.ServerTelemetry)
        .filter(models.ServerTelemetry.timestamp >= cutoff)
        .order_by(models.ServerTelemetry.timestamp.asc())
        .all()
    )
    power_rows = (
        db.query(models.PowerTelemetry)
        .filter(models.PowerTelemetry.timestamp >= cutoff)
        .order_by(models.PowerTelemetry.timestamp.asc())
        .all()
    )
    return {
        "cpu_series": [{"t": r.timestamp.isoformat(), "v": r.cpu_utilization} for r in server_rows],
        "power_series": [{"t": r.timestamp.isoformat(), "v": r.facility_power_kw} for r in power_rows],
    }


# ---------------------------------------------------------------------------
# Model evaluation (ML transparency page)
# ---------------------------------------------------------------------------

@app.get("/model/evaluation")
def model_evaluation():
    if not os.path.exists(METRICS_PATH):
        raise HTTPException(status_code=503, detail="Model not trained yet. Run: python -m app.train_model")
    with open(METRICS_PATH) as f:
        result = json.load(f)
    # Forecast metrics are trained from timestamped live telemetry and are
    # published beside the existing cross-sectional validation models.
    forecast_metrics = forecasting.load_forecast_metrics()
    if forecast_metrics:
        result["workload_forecast"] = forecast_metrics
    return result


@app.get("/thresholds")
def get_thresholds():
    """Exposes the dataset-derived per-server-type idle thresholds and severity
    weights, so the UI can show WHY a server was flagged instead of just THAT
    it was flagged."""
    try:
        with open(rules_engine._THRESHOLDS_PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="Thresholds not computed yet. Run: python -m app.compute_thresholds")


# ---------------------------------------------------------------------------
# ESG report
# ---------------------------------------------------------------------------

def _esg_report_data(days: int, db: Session) -> dict:
    """Build the ESG report from telemetry plus the operator decision audit trail.

    Important: ESG baseline metrics are calculated from telemetry whether or not
    an operator has accepted any recommendation. Accepted actions are reported
    separately as estimated optimization impact.
    """
    days = max(1, min(days, 365))
    now = datetime.utcnow()
    cutoff = now - timedelta(days=days)

    server_rows = (
        db.query(models.ServerTelemetry)
        .filter(models.ServerTelemetry.timestamp >= cutoff)
        .order_by(models.ServerTelemetry.timestamp.asc())
        .all()
    )
    power_rows = (
        db.query(models.PowerTelemetry)
        .filter(models.PowerTelemetry.timestamp >= cutoff)
        .order_by(models.PowerTelemetry.timestamp.asc())
        .all()
    )
    cooling_rows = (
        db.query(models.CoolingTelemetry)
        .filter(models.CoolingTelemetry.timestamp >= cutoff)
        .order_by(models.CoolingTelemetry.timestamp.asc())
        .all()
    )

    # ------------------------------------------------------------------
    # Environmental baseline
    # ------------------------------------------------------------------
    energy_by_server = defaultdict(float)
    for server_id in {row.server_id for row in power_rows}:
        rows = [row for row in power_rows if row.server_id == server_id]
        rows.sort(key=lambda row: row.timestamp)
        for previous, current in zip(rows, rows[1:]):
            hours = (current.timestamp - previous.timestamp).total_seconds() / 3600.0
            if 0 < hours <= rules_engine.MAX_INTERVAL_HOURS:
                energy_by_server[server_id] += previous.facility_power_kw * hours

    energy_kwh = round(sum(energy_by_server.values()), 2)
    cost = round(energy_kwh * TARIFF_PER_KWH, 2)
    site_settings = compliance.get_site_settings(db)
    emission_factor = float(site_settings.grid_emission_factor_kg_per_kwh)
    carbon_kg = round(energy_kwh * emission_factor, 2)

    cooling_type_by_server = dict(
        db.query(models.Server.server_id, models.Server.cooling_type).all()
    )
    water_l = rules_engine.compute_wue_liters_weighted(
        energy_by_server,
        cooling_type_by_server,
    )
    water_l = round(float(water_l or 0), 2)

    try:
        wue_result = rules_engine.compute_wue_rate(
            db,
            window_hours=WUE_WINDOW_HOURS,
        )
        wue = wue_result.get("rate_l_per_kwh")
        wue_window = wue_result.get("window_hours", WUE_WINDOW_HOURS)
    except Exception:
        wue = None
        wue_window = WUE_WINDOW_HOURS

    # ------------------------------------------------------------------
    # Operational baseline
    # ------------------------------------------------------------------
    cpu_values = [r.cpu_utilization for r in server_rows if r.cpu_utilization is not None]
    memory_values = [r.memory_utilization for r in server_rows if r.memory_utilization is not None]
    cooling_efficiency_values = [
        r.cooling_efficiency for r in cooling_rows
        if r.cooling_efficiency is not None
    ]
    it_power_values = [r.it_power_kw for r in power_rows if r.it_power_kw is not None]
    facility_power_values = [
        r.facility_power_kw for r in power_rows
        if r.facility_power_kw is not None
    ]

    avg_cpu = _safe_average(cpu_values)
    avg_memory = _safe_average(memory_values)
    avg_cooling_efficiency = _safe_average(cooling_efficiency_values)
    avg_it_power = _safe_average(it_power_values)
    avg_facility_power = _safe_average(facility_power_values)

    # PUE = Total Facility Power / IT Equipment Power.
    # Calculate it directly here so the KPI, CSV and PDF all use the same value.
    avg_pue = None
    if (
        avg_it_power is not None
        and avg_it_power > 0
        and avg_facility_power is not None
        and avg_facility_power > 0
    ):
        avg_pue = round(avg_facility_power / avg_it_power, 3)

    server_meta = {
        row.server_id: row
        for row in db.query(models.Server).all()
    }

    per_server_cpu = defaultdict(list)
    for row in server_rows:
        if row.cpu_utilization is not None:
            per_server_cpu[row.server_id].append(row.cpu_utilization)

    underutilized_servers = 0
    server_utilization = []
    for server_id, values in per_server_cpu.items():
        server = server_meta.get(server_id)
        average = _safe_average(values)
        threshold = (
            rules_engine.get_idle_threshold(server.server_type)
            if server else None
        )
        is_underutilized = (
            average is not None
            and threshold is not None
            and average < threshold
        )
        if is_underutilized:
            underutilized_servers += 1

        server_utilization.append({
            "server_id": server_id,
            "server_type": server.server_type if server else "Unknown",
            "avg_cpu": average,
            "idle_threshold": threshold,
            "underutilized": is_underutilized,
        })

    # ------------------------------------------------------------------
    # Daily environmental / operational trend
    # ------------------------------------------------------------------
    start_date = cutoff.date()
    end_date = now.date()

    daily = []
    current_date = start_date
    while current_date <= end_date:
        date_string = current_date.isoformat()
        day_server = [r for r in server_rows if r.timestamp.date() == current_date]
        day_power = [r for r in power_rows if r.timestamp.date() == current_date]
        day_cooling = [r for r in cooling_rows if r.timestamp.date() == current_date]

        day_cpu = [r.cpu_utilization for r in day_server if r.cpu_utilization is not None]
        day_memory = [r.memory_utilization for r in day_server if r.memory_utilization is not None]
        day_it = [r.it_power_kw for r in day_power if r.it_power_kw is not None]
        day_facility = [r.facility_power_kw for r in day_power if r.facility_power_kw is not None]
        day_cooling_eff = [
            r.cooling_efficiency for r in day_cooling
            if r.cooling_efficiency is not None
        ]

        # Integrate only intervals fully contained within the calendar day.
        day_energy = 0.0
        by_server = defaultdict(list)
        for row in day_power:
            by_server[row.server_id].append(row)
        for rows in by_server.values():
            rows.sort(key=lambda row: row.timestamp)
            for previous, current in zip(rows, rows[1:]):
                hours = (current.timestamp - previous.timestamp).total_seconds() / 3600.0
                if 0 < hours <= rules_engine.MAX_INTERVAL_HOURS:
                    day_energy += previous.facility_power_kw * hours

        # Daily PUE = average facility power / average IT power.
        day_pue = None
        day_avg_it = _safe_average(day_it)
        day_avg_facility = _safe_average(day_facility)
        if (
            day_avg_it is not None
            and day_avg_it > 0
            and day_avg_facility is not None
            and day_avg_facility > 0
        ):
            day_pue = round(day_avg_facility / day_avg_it, 3)

        has_data = bool(day_server or day_power or day_cooling)

        daily.append({
            "date": date_string,
            "energy_kwh": round(day_energy, 4),
            "carbon_kg": round(day_energy * emission_factor, 4),
            "cost": round(day_energy * TARIFF_PER_KWH, 2),
            "water_liters": None,
            "avg_cpu": _safe_average(day_cpu),
            "avg_memory": _safe_average(day_memory),
            "avg_pue": day_pue,
            "avg_cooling_efficiency": _safe_average(day_cooling_eff),
            "has_data": has_data,
        })
        current_date += timedelta(days=1)

    # ------------------------------------------------------------------
    # Operator decision audit trail
    # ------------------------------------------------------------------
    actions = (
        db.query(models.OperatorAction)
        .filter(models.OperatorAction.created_at >= cutoff)
        .order_by(models.OperatorAction.created_at.desc())
        .all()
    )

    accepted = [a for a in actions if a.action in ("consolidate", "rightsize")]
    snoozed = [a for a in actions if a.action == "snooze"]
    rejected = [a for a in actions if a.action == "do_nothing"]

    optimization_impact = {
        "accepted_actions": len(accepted),
        "energy_saved_kwh": round(
            sum(a.estimated_energy_saving_kwh or 0 for a in accepted), 2
        ),
        "carbon_reduced_kg": round(
            sum(a.estimated_carbon_reduction_kg or 0 for a in accepted), 2
        ),
        "cost_saved": round(
            sum(a.estimated_cost_saving or 0 for a in accepted), 2
        ),
        "storage_reclaimed_gb": round(
            sum(a.estimated_storage_reclaimed_gb or 0 for a in accepted), 2
        ),
    }

    return {
        "range": {
            "days": days,
            "from": cutoff.isoformat(),
            "to": now.isoformat(),
        },
        "environmental": {
            "energy_kwh": energy_kwh,
            "carbon_kg": carbon_kg,
            "cost": cost,
            "water_liters": water_l,
            "wue": wue,
            "wue_window_hours": wue_window,
        },
        "operational_efficiency": {
            "avg_cpu": avg_cpu,
            "avg_memory": avg_memory,
            "avg_pue": avg_pue,
            "avg_cooling_efficiency": avg_cooling_efficiency,
            "underutilized_servers": underutilized_servers,
            "servers_observed": len(per_server_cpu),
        },
        # Top-level alias kept for KPI components that read report.avg_pue directly.
        "avg_pue": avg_pue,
        "factors": {
            "emission_factor_kg_per_kwh": emission_factor,
            "emission_factor_source": site_settings.emission_factor_source,
            "tariff_per_kwh": TARIFF_PER_KWH,
        },
        "optimization_impact": optimization_impact,
        "decision_counts": {
            "accepted": len(accepted),
            "snoozed": len(snoozed),
            "rejected": len(rejected),
            "total": len(actions),
        },
        "daily": daily,
        "server_utilization": server_utilization,
        "note": (
            "Environmental and operational metrics are calculated from telemetry. "
            "Optimization impact contains estimates captured when accepted operator "
            "decisions were recorded. GreenOps does not directly modify infrastructure "
            "or verify realized savings after an action."
        ),
        "decisions": [
            {
                "id": a.id,
                "server_id": a.server_id,
                "target_server_id": a.target_server_id,
                "action": a.action,
                "notes": a.notes,
                "estimated_energy_saving_kwh": a.estimated_energy_saving_kwh,
                "estimated_carbon_reduction_kg": a.estimated_carbon_reduction_kg,
                "estimated_cost_saving": a.estimated_cost_saving,
                "estimated_storage_reclaimed_gb": a.estimated_storage_reclaimed_gb,
                "created_at": a.created_at.isoformat(),
            }
            for a in actions
        ],
    }


@app.get("/reports/esg")
def esg_report(days: int = 30, db: Session = Depends(get_db)):
    return _esg_report_data(days, db)


@app.get("/reports/esg/export")
def esg_report_export(days: int = 30, db: Session = Depends(get_db)):
    """Download the ESG report as CSV."""
    import csv
    import io
    from fastapi.responses import Response

    data = _esg_report_data(days, db)
    buffer = io.StringIO()
    writer = csv.writer(buffer)

    writer.writerow([f"GreenOps ESG Report -- last {data['range']['days']} days"])
    writer.writerow([f"Reporting period: {data['range']['from']} to {data['range']['to']}"])
    writer.writerow([])

    env = data["environmental"]
    eff = data["operational_efficiency"]
    impact = data["optimization_impact"]
    counts = data["decision_counts"]

    writer.writerow(["ENVIRONMENTAL PERFORMANCE"])
    writer.writerow(["Metric", "Value"])
    writer.writerow(["Energy (kWh)", env["energy_kwh"]])
    writer.writerow(["Carbon (kg)", env["carbon_kg"]])
    writer.writerow(["Estimated cost", env["cost"]])
    writer.writerow(["Estimated water (L)", env["water_liters"]])
    writer.writerow(["WUE (L/kWh, water / IT energy)", env["wue"]])
    writer.writerow(["Grid emission factor (kg CO2e/kWh)", data["factors"]["emission_factor_kg_per_kwh"]])
    writer.writerow(["Emission factor source", data["factors"]["emission_factor_source"]])
    writer.writerow([])

    writer.writerow(["OPERATIONAL EFFICIENCY"])
    writer.writerow(["Metric", "Value"])
    writer.writerow(["Average CPU (%)", eff["avg_cpu"]])
    writer.writerow(["Average Memory (%)", eff["avg_memory"]])
    writer.writerow(["Average PUE", eff["avg_pue"]])
    writer.writerow(["Cooling Efficiency", eff["avg_cooling_efficiency"]])
    writer.writerow(["Underutilized Servers", eff["underutilized_servers"]])
    writer.writerow(["Servers Observed", eff["servers_observed"]])
    writer.writerow([])

    writer.writerow(["OPTIMIZATION IMPACT"])
    writer.writerow(["Metric", "Value"])
    writer.writerow(["Accepted Actions", impact["accepted_actions"]])
    writer.writerow(["Energy Saved (kWh)", impact["energy_saved_kwh"]])
    writer.writerow(["Carbon Reduced (kg)", impact["carbon_reduced_kg"]])
    writer.writerow(["Cost Saved", impact["cost_saved"]])
    writer.writerow(["Storage Reclaimed (GB)", impact["storage_reclaimed_gb"]])
    writer.writerow([])

    writer.writerow(["DECISION SUMMARY"])
    writer.writerow(["Accepted", counts["accepted"]])
    writer.writerow(["Snoozed", counts["snoozed"]])
    writer.writerow(["Rejected", counts["rejected"]])
    writer.writerow(["Total", counts["total"]])
    writer.writerow([])

    writer.writerow(["DAILY TREND"])
    writer.writerow([
        "date", "energy_kwh", "carbon_kg", "cost", "avg_cpu",
        "avg_memory", "avg_pue", "avg_cooling_efficiency", "has_data"
    ])
    for row in data["daily"]:
        writer.writerow([
            row["date"], row["energy_kwh"], row["carbon_kg"], row["cost"],
            row["avg_cpu"], row["avg_memory"], row["avg_pue"],
            row["avg_cooling_efficiency"], row["has_data"],
        ])
    writer.writerow([])

    writer.writerow(["DECISION AUDIT TRAIL"])
    writer.writerow([
        "id", "server_id", "target_server_id", "action", "notes",
        "estimated_energy_saving_kwh", "estimated_carbon_reduction_kg",
        "estimated_cost_saving", "estimated_storage_reclaimed_gb", "created_at",
    ])
    for row in data["decisions"]:
        writer.writerow([
            row["id"], row["server_id"], row["target_server_id"] or "",
            row["action"], row["notes"] or "",
            row["estimated_energy_saving_kwh"],
            row["estimated_carbon_reduction_kg"],
            row["estimated_cost_saving"],
            row["estimated_storage_reclaimed_gb"],
            row["created_at"],
        ])

    writer.writerow([])
    writer.writerow([data["note"]])

    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition":
            f"attachment; filename=greenops_esg_report_{days}d.csv"
        },
    )


@app.get("/reports/esg/export/pdf")
def esg_report_export_pdf(days: int = 30, db: Session = Depends(get_db)):
    """Generate a human-readable ESG PDF with summary metrics and trend charts."""
    import io

    from fastapi.responses import Response

    try:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_CENTER
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate,
            Paragraph,
            Spacer,
            Table,
            TableStyle,
            Image,
            PageBreak,
        )
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail=(
                "PDF export requires reportlab and matplotlib. "
                "Install them with: pip install reportlab matplotlib"
            ),
        ) from exc

    data = _esg_report_data(days, db)
    env = data["environmental"]
    eff = data["operational_efficiency"]
    impact = data["optimization_impact"]
    counts = data["decision_counts"]

    pdf_buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        pdf_buffer,
        pagesize=A4,
        rightMargin=15 * mm,
        leftMargin=15 * mm,
        topMargin=15 * mm,
        bottomMargin=15 * mm,
        title="GreenOps ESG & Sustainability Report",
        author="GreenOps",
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "GreenOpsTitle",
        parent=styles["Title"],
        alignment=TA_CENTER,
        fontSize=20,
        leading=24,
        spaceAfter=8,
    )
    section_style = ParagraphStyle(
        "GreenOpsSection",
        parent=styles["Heading2"],
        fontSize=13,
        leading=16,
        spaceBefore=8,
        spaceAfter=6,
    )
    small_style = ParagraphStyle(
        "GreenOpsSmall",
        parent=styles["BodyText"],
        fontSize=8.5,
        leading=11,
    )

    story = []
    story.append(Paragraph("GreenOps ESG & Sustainability Report", title_style))
    story.append(Paragraph(
        f"Reporting period: {data['range']['from']} to {data['range']['to']}",
        styles["BodyText"],
    ))
    story.append(Spacer(1, 8))

    # Executive summary
    story.append(Paragraph("1. Executive Summary", section_style))
    summary_data = [
        ["Energy", f"{env['energy_kwh']:.2f} kWh"],
        ["Carbon", f"{env['carbon_kg']:.2f} kg CO2e"],
        ["Estimated Cost", f"{env['cost']:.2f}"],
        ["Estimated Water", f"{env['water_liters']:.2f} L"],
        ["Average PUE", "—" if eff["avg_pue"] is None else f"{eff['avg_pue']:.3f}"],
        ["Average CPU", "—" if eff["avg_cpu"] is None else f"{eff['avg_cpu']:.2f}%"],
        ["Underutilized Servers", str(eff["underutilized_servers"])],
        ["Accepted Recommendations", str(impact["accepted_actions"])],
    ]
    table = Table(summary_data, colWidths=[65 * mm, 65 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#EAF2F8")),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (1, 0), (1, -1), "Helvetica"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("PADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(table)
    story.append(Spacer(1, 10))

    # Environmental performance
    story.append(Paragraph("2. Environmental Performance", section_style))
    environmental_table = Table([
        ["Metric", "Value"],
        ["Energy Consumption", f"{env['energy_kwh']:.2f} kWh"],
        ["Estimated Carbon", f"{env['carbon_kg']:.2f} kg"],
        ["Estimated Cost", f"{env['cost']:.2f}"],
        ["Estimated Water", f"{env['water_liters']:.2f} L"],
        ["WUE", "—" if env["wue"] is None else f"{env['wue']:.3f} L/kWh"],
    ], colWidths=[70 * mm, 60 * mm])
    environmental_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#D5F5E3")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ("PADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(environmental_table)

    # Operational efficiency
    story.append(Paragraph("3. Operational Efficiency", section_style))
    operational_table = Table([
        ["Metric", "Value"],
        ["Average CPU", "—" if eff["avg_cpu"] is None else f"{eff['avg_cpu']:.2f}%"],
        ["Average Memory", "—" if eff["avg_memory"] is None else f"{eff['avg_memory']:.2f}%"],
        ["Average PUE", "—" if eff["avg_pue"] is None else f"{eff['avg_pue']:.3f}"],
        ["Cooling Efficiency", "—" if eff["avg_cooling_efficiency"] is None else f"{eff['avg_cooling_efficiency']:.3f}"],
        ["Underutilized Servers", str(eff["underutilized_servers"])],
        ["Servers Observed", str(eff["servers_observed"])],
    ], colWidths=[70 * mm, 60 * mm])
    operational_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#FCF3CF")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ("PADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(operational_table)

    # Trend charts
    chart_rows = [row for row in data["daily"] if row["has_data"]]
    if chart_rows:
        dates = [row["date"] for row in chart_rows]

        energy_values = [row["energy_kwh"] for row in chart_rows]
        fig1, ax1 = plt.subplots(figsize=(7.0, 3.0))
        ax1.plot(dates, energy_values, marker="o")
        ax1.set_title("Daily Energy Consumption")
        ax1.set_ylabel("Energy (kWh)")
        ax1.grid(True, alpha=0.3)
        fig1.autofmt_xdate(rotation=45)
        fig1.tight_layout()
        energy_buffer = io.BytesIO()
        fig1.savefig(energy_buffer, format="png", dpi=150, bbox_inches="tight")
        plt.close(fig1)
        energy_buffer.seek(0)

        carbon_values = [row["carbon_kg"] for row in chart_rows]
        fig2, ax2 = plt.subplots(figsize=(7.0, 3.0))
        ax2.plot(dates, carbon_values, marker="o")
        ax2.set_title("Daily Estimated Carbon")
        ax2.set_ylabel("Carbon (kg)")
        ax2.grid(True, alpha=0.3)
        fig2.autofmt_xdate(rotation=45)
        fig2.tight_layout()
        carbon_buffer = io.BytesIO()
        fig2.savefig(carbon_buffer, format="png", dpi=150, bbox_inches="tight")
        plt.close(fig2)
        carbon_buffer.seek(0)

        story.append(PageBreak())
        story.append(Paragraph("4. Energy & Carbon Trends", section_style))
        story.append(Image(energy_buffer, width=170 * mm, height=72 * mm))
        story.append(Spacer(1, 8))
        story.append(Image(carbon_buffer, width=170 * mm, height=72 * mm))

    # Optimization impact
    story.append(PageBreak())
    story.append(Paragraph("5. Optimization Impact", section_style))
    impact_table = Table([
        ["Metric", "Value"],
        ["Accepted Actions", str(impact["accepted_actions"])],
        ["Estimated Energy Saved", f"{impact['energy_saved_kwh']:.2f} kWh"],
        ["Estimated Carbon Reduced", f"{impact['carbon_reduced_kg']:.2f} kg"],
        ["Estimated Cost Saved", f"{impact['cost_saved']:.2f}"],
        ["Storage Reclaimed", f"{impact['storage_reclaimed_gb']:.2f} GB"],
    ], colWidths=[75 * mm, 55 * mm])
    impact_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#D6EAF8")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ("PADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(impact_table)
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "Optimization figures are estimates captured when an operator accepted a recommendation. "
        "They are not verified post-action savings.",
        small_style,
    ))

    # Decision audit trail
    story.append(Paragraph("6. Decision Audit Trail", section_style))
    audit_data = [[
        "ID", "Server", "Target", "Action", "Energy kWh", "Carbon kg", "Created"
    ]]
    for row in data["decisions"]:
        created = row["created_at"][:19].replace("T", " ")
        audit_data.append([
            str(row["id"]),
            str(row["server_id"]),
            str(row["target_server_id"] or "—"),
            str(row["action"]),
            f"{row['estimated_energy_saving_kwh'] or 0:.2f}",
            f"{row['estimated_carbon_reduction_kg'] or 0:.2f}",
            created,
        ])

    if len(audit_data) == 1:
        audit_data.append(["—", "—", "—", "No actions", "0.00", "0.00", "—"])

    audit_table = Table(
        audit_data,
        repeatRows=1,
        colWidths=[12 * mm, 25 * mm, 25 * mm, 25 * mm, 22 * mm, 22 * mm, 35 * mm],
    )
    audit_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAECEE")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
        ("FONTSIZE", (0, 0), (-1, -1), 7),
        ("PADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(audit_table)

    # Methodology
    story.append(Paragraph("7. Methodology & Assumptions", section_style))
    methodology = [
        f"Energy is estimated by integrating facility power across adjacent telemetry readings within the configured interval guard ({rules_engine.MAX_INTERVAL_HOURS} hours).",
        f"Estimated cost uses a configured tariff of {TARIFF_PER_KWH:.2f} per kWh.",
        f"Estimated carbon uses a grid emission factor of {data['factors']['emission_factor_kg_per_kwh']:.3f} kg CO2e per kWh ({data['factors']['emission_factor_source']}).",
        "Water usage is an estimate weighted by the cooling type associated with each server. WUE is that estimated water divided by IT equipment energy over the same window.",
        "PUE is facility power divided by IT power over the same observed window.",
        "Operator decisions are recommendations recorded for human review; GreenOps does not directly control physical infrastructure.",
    ]
    for item in methodology:
        story.append(Paragraph("• " + item, small_style))
        story.append(Spacer(1, 2))

    story.append(Spacer(1, 8))
    story.append(Paragraph(data["note"], small_style))

    doc.build(story)
    pdf_buffer.seek(0)

    return Response(
        content=pdf_buffer.getvalue(),
        media_type="application/pdf",
        headers={
            "Content-Disposition":
            f"attachment; filename=greenops_esg_report_{days}d.pdf"
        },
    )


# ---------------------------------------------------------------------------
# Compliance readiness
#
# Maps telemetry onto external framework indicator definitions and reports,
# per indicator, whether GreenOps can provide it and how trustworthy it is.
# Alignment with a framework's definitions, NOT a compliance declaration.
# Declared inputs (emission factor, capacity, REF, ERF) live in site_settings.
# ---------------------------------------------------------------------------

@app.get("/compliance/frameworks")
def compliance_frameworks(current_user: models.User = Depends(get_current_user)):
    return compliance.list_frameworks()


# Registered before /compliance/{framework_id} so "settings" is never read as a framework id.
@app.get("/compliance/settings")
def get_compliance_settings(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    return compliance.settings_to_dict(compliance.get_site_settings(db))


@app.put("/compliance/settings")
def update_compliance_settings(
    payload: schemas.SiteSettingsIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_role("infrastructure_manager")),
):
    """Update the emission factor and declared inputs. Infrastructure Manager only."""
    row = compliance.get_site_settings(db)
    row.grid_emission_factor_kg_per_kwh = payload.grid_emission_factor_kg_per_kwh
    row.emission_factor_source = payload.emission_factor_source.strip()
    row.installed_it_capacity_kw = payload.installed_it_capacity_kw
    row.renewable_energy_factor = payload.renewable_energy_factor
    row.energy_reuse_factor = payload.energy_reuse_factor
    row.telemetry_simulated = payload.telemetry_simulated
    row.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return compliance.settings_to_dict(row)


@app.get("/compliance/{framework_id}")
def compliance_report(
    framework_id: str,
    days: int = 30,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    report = compliance.evaluate_framework(db, framework_id, days)
    if report is None:
        known = ", ".join(sorted(compliance.FRAMEWORKS))
        raise HTTPException(status_code=404, detail=f"Unknown framework. Available: {known}")
    return report


@app.get("/")
def root():
    return {"status": "GreenOps Phase 1 API running", "docs": "/docs"}
