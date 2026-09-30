"""
Rule-based resource optimization detection.

These checks deliberately do NOT use machine learning. They are simple,
explainable thresholds -- exactly the kind of logic a real operator could
verify by hand. This is what makes "idle server detection" and "storage
optimization insights" available from day one, without waiting on a trained
model.
"""
import json
import os
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timedelta
from . import models

# ---- Tunable thresholds -----------------------------------------------
IDLE_LOOKBACK_HOURS = 6
STALE_DATA_DAYS = 90
DUPLICATE_RATIO_THRESHOLD = 0.20   # 20% of total storage
OVERPROVISION_RATIO_THRESHOLD = 0.30  # used/total < 30%
# ------------------------------------------------------------------------

# ---- Per-server-type idle thresholds, derived from the real dataset ----
# Replaces the old flat "20% for everyone" rule. See compute_thresholds.py
# for how this table was generated: threshold = mean_cpu(type) - 1.5*std(type)
# per server_type, clamped to [5, 35]. severity_weight scales with that
# type's average power draw, so an idle GPU server (which draws far more
# power than an idle Edge server at the same CPU%) is flagged as higher
# priority waste, not treated identically.
_THRESHOLDS_PATH = os.path.join(os.path.dirname(__file__), "data", "type_thresholds.json")
_type_thresholds = None


def _load_type_thresholds():
    global _type_thresholds
    if _type_thresholds is None:
        try:
            with open(_THRESHOLDS_PATH) as f:
                _type_thresholds = json.load(f)
        except FileNotFoundError:
            # Fallback if compute_thresholds.py hasn't been run yet.
            _type_thresholds = {"_default": {"idle_cpu_threshold": 20.0, "severity_weight": 1.0}}
    return _type_thresholds


def get_idle_threshold(server_type: str) -> float:
    table = _load_type_thresholds()
    return table.get(server_type, table["_default"])["idle_cpu_threshold"]


def get_severity_weight(server_type: str) -> float:
    table = _load_type_thresholds()
    return table.get(server_type, table["_default"])["severity_weight"]


def _upsert_flag(db: Session, server_id: str, flag_type: str, severity: str,
                  detail: str, metric_value: float):
    """Avoid duplicate active flags of the same type for the same server."""
    existing = (
        db.query(models.Flag)
        .filter(
            models.Flag.server_id == server_id,
            models.Flag.flag_type == flag_type,
            models.Flag.resolved == 0,
        )
        .first()
    )
    if existing:
        existing.detail = detail
        existing.metric_value = metric_value
        existing.severity = severity
        existing.created_at = datetime.utcnow()
    else:
        db.add(models.Flag(
            server_id=server_id,
            flag_type=flag_type,
            severity=severity,
            detail=detail,
            metric_value=metric_value,
        ))
    db.commit()


def _resolve_flag(db: Session, server_id: str, flag_type: str):
    """
    Clears an active flag once its underlying condition is no longer true.
    Without this, a flag created once stays active forever -- checked on
    every new reading, same as _upsert_flag, so a server that recovers is
    reflected here just as promptly as one that starts misbehaving.
    """
    existing = (
        db.query(models.Flag)
        .filter(
            models.Flag.server_id == server_id,
            models.Flag.flag_type == flag_type,
            models.Flag.resolved == 0,
        )
        .first()
    )
    if existing:
        existing.resolved = 1
        db.commit()


def check_idle_server(db: Session, server_id: str):
    """
    Flag a server whose average CPU has stayed below ITS OWN TYPE'S
    statistically-derived threshold -- not one flat number shared by
    every server type.
    """
    server = db.query(models.Server).filter(models.Server.server_id == server_id).first()
    server_type = server.server_type if server else "_default"

    threshold = get_idle_threshold(server_type)
    severity_weight = get_severity_weight(server_type)

    cutoff = datetime.utcnow() - timedelta(hours=IDLE_LOOKBACK_HOURS)
    avg_cpu = (
        db.query(func.avg(models.ServerTelemetry.cpu_utilization))
        .filter(
            models.ServerTelemetry.server_id == server_id,
            models.ServerTelemetry.timestamp >= cutoff,
        )
        .scalar()
    )
    if avg_cpu is None:
        return
    if avg_cpu < threshold:
        # Higher severity_weight (e.g. GPU at 1.66x) -> flagged as higher priority,
        # since the same idle CPU% wastes more power on more power-hungry hardware.
        severity = "high" if severity_weight >= 1.5 else "medium" if severity_weight >= 1.1 else "low"
        _upsert_flag(
            db, server_id, "idle_server", severity,
            f"Average CPU {avg_cpu:.1f}% over last {IDLE_LOOKBACK_HOURS}h "
            f"(threshold for {server_type}: {threshold}%, derived from dataset "
            f"mean/std for this server type) — consolidation candidate. "
            f"Severity weight {severity_weight}x reflects {server_type}'s "
            f"typical power draw relative to other types.",
            metric_value=round(avg_cpu, 2),
        )
    else:
        _resolve_flag(db, server_id, "idle_server")


def check_storage(db: Session, row: models.StorageTelemetry):
    """Run all storage-related rule checks for a single new reading."""
    server_id = row.server_id

    # Stale data
    if row.last_accessed_days_ago > STALE_DATA_DAYS:
        _upsert_flag(
            db, server_id, "stale_data", "low",
            f"Data last accessed {row.last_accessed_days_ago} days ago "
            f"(threshold {STALE_DATA_DAYS}) — archive candidate.",
            metric_value=row.used_storage_gb,
        )
    else:
        _resolve_flag(db, server_id, "stale_data")

    # Duplicate data / over-provisioned both need a valid total_storage_gb to
    # evaluate -- if it's not positive, leave existing flags as-is rather
    # than resolving them off invalid data.
    if row.total_storage_gb > 0:
        dup_ratio = row.duplicate_data_gb / row.total_storage_gb
        if dup_ratio > DUPLICATE_RATIO_THRESHOLD:
            _upsert_flag(
                db, server_id, "duplicate_data", "medium",
                f"Duplicate data is {dup_ratio*100:.1f}% of total storage "
                f"(threshold {DUPLICATE_RATIO_THRESHOLD*100:.0f}%) — "
                f"deduplication candidate.",
                metric_value=row.duplicate_data_gb,
            )
        else:
            _resolve_flag(db, server_id, "duplicate_data")

        # Over-provisioned
        used_ratio = row.used_storage_gb / row.total_storage_gb
        if used_ratio < OVERPROVISION_RATIO_THRESHOLD:
            excess_gb = row.total_storage_gb - row.used_storage_gb
            _upsert_flag(
                db, server_id, "overprovisioned", "low",
                f"Only {used_ratio*100:.1f}% of allocated storage is used "
                f"(threshold {OVERPROVISION_RATIO_THRESHOLD*100:.0f}%) — "
                f"downsize candidate.",
                metric_value=round(excess_gb, 2),
            )
        else:
            _resolve_flag(db, server_id, "overprovisioned")


def compute_pue(it_power_kw: float, facility_power_kw: float) -> float:
    if it_power_kw <= 0:
        return 0.0
    return round(facility_power_kw / it_power_kw, 3)


def get_time_of_day(timestamp: datetime = None) -> str:
    """
    Maps a real clock hour onto the three time_of_day categories the CPU/
    power validation models were actually trained on (green_ai_datacenter.csv
    has only Night/Off-Peak/Peak -- no fourth bucket). A stated convention,
    not derived from data, same spirit as the idle-threshold clamp: Night
    00:00-06:00, Peak 09:00-21:00 (typical high-demand hours), Off-Peak for
    the two shoulder windows in between. Replaces the previous hardcoded
    "Peak" that was used for every inference regardless of actual time.
    """
    hour = (timestamp or datetime.utcnow()).hour
    if hour < 6:
        return "Night"
    if hour < 9:
        return "Off-Peak"
    if hour < 21:
        return "Peak"
    return "Off-Peak"


# Assumed water intensity (L per kWh of FACILITY energy) by cooling type --
# clearly labeled as an industry-average estimate, since real facility water
# meters aren't available for this prototype. Modelled water = facility
# energy x this factor. The WUE KPI reported to operators and compliance
# frameworks divides that water by IT energy instead; see compute_wue_rate().
# See project notes for justification.
#
# Keys match the simulators' cooling_type vocabulary, which was deliberately
# restricted to green_ai_datacenter.csv's own categories (Air/Hybrid/Liquid)
# -- "Hybrid", not "Evaporative", is the real training-data category.
WUE_FACTORS = {
    "Air": 0.3,
    "Hybrid": 1.8,
    "Liquid": 0.9,
}


# Telemetry normally arrives every ~15-30s (see simulators/*_monitor.py). A gap
# longer than this means the simulator was stopped, not that the server kept
# drawing power the whole time -- so gaps beyond this are excluded from the
# integral rather than counted as sustained full-power draw.
MAX_INTERVAL_HOURS = 5 / 60  # 5 minutes


def _integrate_energy_by_server(db: Session, cutoff=None) -> dict:
    """
    True energy integration per server: sum facility_power_kw * hours_elapsed
    between consecutive readings (a left Riemann sum over the actual recorded
    timestamps) -- not a fixed-interval-per-reading assumption, which silently
    breaks the moment the posting cadence changes.

    Broken out per server (rather than one facility-wide total) so downstream
    calculations -- like water use -- can weight by each server's OWN cooling
    type instead of assuming one cooling type applies to the whole facility.

    `cutoff`, if given, restricts the integration to readings at or after that
    timestamp -- used for a recent window rather than "since telemetry began".
    Readings just before the window aren't included, so the very first
    interval inside the window is slightly undercounted; acceptable for an
    already-estimated rate, not worth the extra query complexity here.
    """
    energy_by_server = {}
    server_ids = [row[0] for row in db.query(models.PowerTelemetry.server_id).distinct()]
    for server_id in server_ids:
        query = db.query(models.PowerTelemetry).filter(models.PowerTelemetry.server_id == server_id)
        if cutoff is not None:
            query = query.filter(models.PowerTelemetry.timestamp >= cutoff)
        rows = query.order_by(models.PowerTelemetry.timestamp.asc()).all()
        kwh = 0.0
        for prev, curr in zip(rows, rows[1:]):
            hours = (curr.timestamp - prev.timestamp).total_seconds() / 3600.0
            if 0 < hours <= MAX_INTERVAL_HOURS:
                kwh += prev.facility_power_kw * hours
        energy_by_server[server_id] = kwh
    return energy_by_server


def integrate_facility_and_it_energy(db: Session, cutoff=None) -> tuple:
    """
    Same left-Riemann integration as _integrate_energy_by_server(), but
    returns BOTH facility energy and IT-equipment energy per server from a
    single pass over the power readings: (facility_by_server, it_by_server),
    in kWh.

    Both are needed because standards define their KPIs against different
    energies: PUE is facility energy over IT energy, and WUE is water over
    IT energy (ISO/IEC 30134, EU Delegated Regulation 2024/1364), while
    cost and carbon follow the total electricity bought, i.e. facility
    energy. Same gap guard as everywhere else: intervals longer than
    MAX_INTERVAL_HOURS are simulator downtime, not sustained draw.
    """
    facility_by_server = {}
    it_by_server = {}
    server_ids = [row[0] for row in db.query(models.PowerTelemetry.server_id).distinct()]
    for server_id in server_ids:
        query = db.query(models.PowerTelemetry).filter(models.PowerTelemetry.server_id == server_id)
        if cutoff is not None:
            query = query.filter(models.PowerTelemetry.timestamp >= cutoff)
        rows = query.order_by(models.PowerTelemetry.timestamp.asc()).all()
        facility_kwh = 0.0
        it_kwh = 0.0
        for prev, curr in zip(rows, rows[1:]):
            hours = (curr.timestamp - prev.timestamp).total_seconds() / 3600.0
            if 0 < hours <= MAX_INTERVAL_HOURS:
                facility_kwh += prev.facility_power_kw * hours
                it_kwh += prev.it_power_kw * hours
        facility_by_server[server_id] = facility_kwh
        it_by_server[server_id] = it_kwh
    return facility_by_server, it_by_server


def compute_energy_by_server(db: Session) -> dict:
    """Cumulative per-server energy, since telemetry began."""
    return _integrate_energy_by_server(db)


def compute_energy_by_server_windowed(db: Session, window_hours: float) -> dict:
    """Per-server energy restricted to the last `window_hours`."""
    cutoff = datetime.utcnow() - timedelta(hours=window_hours)
    return _integrate_energy_by_server(db, cutoff)


def compute_energy_kwh(db: Session) -> float:
    """Facility-wide total -- sum of compute_energy_by_server()."""
    return round(sum(compute_energy_by_server(db).values()), 4)


def compute_wue_liters_weighted(energy_by_server: dict, cooling_type_by_server: dict) -> float:
    """
    Water total weighted by each server's own cooling type and its own share
    of energy use, instead of applying one cooling type's WUE factor to the
    whole facility's energy. Servers on different cooling systems (Air vs.
    Hybrid vs. Liquid) have WUE factors up to 6x apart, so picking a
    single "representative" cooling type can swing the facility-wide number
    wildly depending on which one happens to be picked.

    Takes whatever `energy_by_server` it's given -- cumulative or windowed --
    so it works for both the running total and the windowed rate below.
    """
    total_liters = 0.0
    for server_id, kwh in energy_by_server.items():
        cooling_type = cooling_type_by_server.get(server_id, "Air")
        factor = WUE_FACTORS.get(cooling_type, 0.5)
        total_liters += kwh * factor
    return round(total_liters, 2)


DEFAULT_WUE_WINDOW_HOURS = 1


def compute_wue_rate(db: Session, window_hours: float = DEFAULT_WUE_WINDOW_HOURS) -> dict:
    """
    WUE as an actual RATE (liters per kWh) over a recent window -- not a
    cumulative total. Real-world WUE is defined as water used per unit of
    energy consumed: a ratio that should stabilize once the system reaches
    steady state, not climb forever the longer telemetry has been running.

    Still an estimate, same as the cumulative total: built on the same
    placeholder industry-average WUE_FACTORS, not a real water meter reading.

    The denominator is IT EQUIPMENT energy, not facility energy. That is the
    standard definition (The Green Grid, ISO/IEC 30134, EU Delegated
    Regulation 2024/1364: WUE = water / E_IT). The modelled water itself
    still scales with FACILITY energy (cooling water follows the heat being
    rejected, which tracks total facility power), so the reported WUE is the
    energy-weighted factor multiplied by PUE. Dividing by facility energy,
    as this function used to, understated WUE by roughly the PUE.
    """
    facility_by_server, it_by_server = integrate_facility_and_it_energy(
        db, datetime.utcnow() - timedelta(hours=window_hours)
    )
    cooling_type_by_server = dict(db.query(models.Server.server_id, models.Server.cooling_type).all())
    water_l = compute_wue_liters_weighted(facility_by_server, cooling_type_by_server)
    it_energy_kwh = round(sum(it_by_server.values()), 4)
    facility_energy_kwh = round(sum(facility_by_server.values()), 4)
    rate = round(water_l / it_energy_kwh, 3) if it_energy_kwh > 0 else None
    return {
        "rate_l_per_kwh": rate,
        "window_hours": window_hours,
        "water_in_window_l": water_l,
        "energy_in_window_kwh": it_energy_kwh,
        "facility_energy_in_window_kwh": facility_energy_kwh,
    }
