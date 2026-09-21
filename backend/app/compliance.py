"""
Compliance-readiness layer.

Maps GreenOps telemetry onto the indicator definitions used by external
reporting frameworks and reports, for each required indicator, whether
GreenOps can provide it and how trustworthy the value is.

This is ALIGNMENT, not certification. Telemetry in this prototype is
simulated, water and emissions rest on reference factors rather than meters,
and nothing here has been independently assured. Every indicator therefore
carries a status instead of a bare number:

    derived    calculated directly from telemetry readings
    estimated  modelled from a reference or placeholder factor
    declared   entered by an operator in the site settings (never inferred)
    missing    GreenOps cannot provide it, and the report says so

Frameworks are plain data (FRAMEWORKS below), so adding one means adding a
dict entry, not new endpoint code.
"""
from datetime import datetime, timedelta

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import models, rules_engine

# India all-India weighted-average grid factor, CEA CO2 Baseline Database
# v21.0 (December 2025), FY2024-25. A location-based Scope 2 factor. It
# replaces the earlier flat 0.5 placeholder, which understated carbon for an
# Indian deployment by roughly 30%.
DEFAULT_EMISSION_FACTOR_KG_PER_KWH = 0.710
DEFAULT_EMISSION_FACTOR_SOURCE = (
    "CEA CO2 Baseline Database v21.0, FY2024-25 all-India weighted average (0.710 tCO2/MWh)"
)

# EU Delegated Regulation 2024/1364 applies to data centres with an installed
# IT power demand of at least this much.
EU_REPORTING_THRESHOLD_KW = 500.0

STATUS_DERIVED = "derived"
STATUS_ESTIMATED = "estimated"
STATUS_DECLARED = "declared"
STATUS_MISSING = "missing"
AVAILABLE_STATUSES = (STATUS_DERIVED, STATUS_ESTIMATED, STATUS_DECLARED)


# ---------------------------------------------------------------------------
# Site settings
# ---------------------------------------------------------------------------

def get_site_settings(db: Session) -> models.SiteSettings:
    """Single settings row (id=1), created with defaults on first use."""
    row = db.query(models.SiteSettings).filter(models.SiteSettings.id == 1).first()
    if row is not None:
        return row

    row = models.SiteSettings(
        id=1,
        grid_emission_factor_kg_per_kwh=DEFAULT_EMISSION_FACTOR_KG_PER_KWH,
        emission_factor_source=DEFAULT_EMISSION_FACTOR_SOURCE,
        telemetry_simulated=True,
        updated_at=datetime.utcnow(),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # A concurrent request created it first.
        db.rollback()
        return db.query(models.SiteSettings).filter(models.SiteSettings.id == 1).one()
    db.refresh(row)
    return row


def emission_factor(db: Session) -> float:
    """kg CO2e per kWh, the single source of truth for every carbon figure."""
    return float(get_site_settings(db).grid_emission_factor_kg_per_kwh)


def settings_to_dict(row: models.SiteSettings) -> dict:
    return {
        "grid_emission_factor_kg_per_kwh": row.grid_emission_factor_kg_per_kwh,
        "emission_factor_source": row.emission_factor_source,
        "installed_it_capacity_kw": row.installed_it_capacity_kw,
        "renewable_energy_factor": row.renewable_energy_factor,
        "energy_reuse_factor": row.energy_reuse_factor,
        "telemetry_simulated": bool(row.telemetry_simulated),
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


# ---------------------------------------------------------------------------
# Framework definitions
# ---------------------------------------------------------------------------

FRAMEWORKS = {
    "eu-2024-1364": {
        "name": "EU Delegated Regulation 2024/1364, data centre reporting",
        "reference": "Commission Delegated Regulation (EU) 2024/1364 of 14 March 2024",
        "jurisdiction": "European Union",
        "scope_note": (
            "Applies to data centres with an installed IT power demand of at least "
            f"{EU_REPORTING_THRESHOLD_KW:.0f} kW."
        ),
        "indicators": [
            "installed_it_capacity_kw",
            "energy_dc_kwh",
            "energy_it_kwh",
            "pue",
            "wue",
            "erf",
            "ref",
        ],
    },
    "brsr-core": {
        "name": "SEBI BRSR Core, environmental attributes (indicative mapping)",
        "reference": "SEBI Business Responsibility and Sustainability Reporting, BRSR Core",
        "jurisdiction": "India",
        "scope_note": (
            "Reported by listed entities at organisation level, with independent assurance. "
            "GreenOps can only supply data centre inputs to such a report. Intensity ratios "
            "need financial turnover, which is outside GreenOps."
        ),
        "indicators": [
            "energy_dc_kwh",
            "scope2_kg",
            "scope1_kg",
            "water_l",
        ],
    },
}


def list_frameworks() -> list:
    return [
        {
            "id": framework_id,
            "name": framework["name"],
            "reference": framework["reference"],
            "jurisdiction": framework["jurisdiction"],
            "indicator_count": len(framework["indicators"]),
        }
        for framework_id, framework in FRAMEWORKS.items()
    ]


# ---------------------------------------------------------------------------
# Indicator calculation
# ---------------------------------------------------------------------------

def _indicator(indicator_id, label, unit, formula, value, status, source, note=None):
    return {
        "id": indicator_id,
        "label": label,
        "unit": unit,
        "formula": formula,
        "value": value,
        "status": status,
        "source": source,
        "note": note,
    }


def compute_indicators(db: Session, days: int) -> dict:
    """
    Every indicator any supported framework can ask for, over the last `days`
    days. Frameworks then just select the ones they require.
    """
    days = max(1, min(int(days), 365))
    now = datetime.utcnow()
    cutoff = now - timedelta(days=days)
    settings = get_site_settings(db)

    facility_by_server, it_by_server = rules_engine.integrate_facility_and_it_energy(db, cutoff)
    e_dc = sum(facility_by_server.values())
    e_it = sum(it_by_server.values())
    has_energy = e_dc > 0 and e_it > 0

    cooling_type_by_server = dict(
        db.query(models.Server.server_id, models.Server.cooling_type).all()
    )
    water_l = rules_engine.compute_wue_liters_weighted(facility_by_server, cooling_type_by_server)

    peak_rows = (
        db.query(models.PowerTelemetry.server_id, func.max(models.PowerTelemetry.it_power_kw))
        .filter(models.PowerTelemetry.timestamp >= cutoff)
        .group_by(models.PowerTelemetry.server_id)
        .all()
    )
    observed_peak_kw = sum((row[1] or 0.0) for row in peak_rows)

    ef = float(settings.grid_emission_factor_kg_per_kwh)
    no_data_note = "No power telemetry in the reporting period."

    indicators = {}

    if settings.installed_it_capacity_kw is not None:
        indicators["installed_it_capacity_kw"] = _indicator(
            "installed_it_capacity_kw", "Installed IT power demand", "kW", "declared by operator",
            round(settings.installed_it_capacity_kw, 2), STATUS_DECLARED, "Site settings",
        )
    elif observed_peak_kw > 0:
        indicators["installed_it_capacity_kw"] = _indicator(
            "installed_it_capacity_kw", "Installed IT power demand", "kW", "sum of per-server peak IT power",
            round(observed_peak_kw, 2), STATUS_ESTIMATED, "Power telemetry",
            "No installed capacity declared, so the observed peak IT power is used instead.",
        )
    else:
        indicators["installed_it_capacity_kw"] = _indicator(
            "installed_it_capacity_kw", "Installed IT power demand", "kW", "declared by operator",
            None, STATUS_MISSING, "Site settings", "Not declared and no power telemetry to estimate from.",
        )

    indicators["energy_dc_kwh"] = _indicator(
        "energy_dc_kwh", "Total data centre energy (E_DC)", "kWh", "sum of facility power x elapsed hours",
        round(e_dc, 2) if has_energy else None,
        STATUS_DERIVED if has_energy else STATUS_MISSING, "Power telemetry",
        None if has_energy else no_data_note,
    )
    indicators["energy_it_kwh"] = _indicator(
        "energy_it_kwh", "IT equipment energy (E_IT)", "kWh", "sum of IT power x elapsed hours",
        round(e_it, 2) if has_energy else None,
        STATUS_DERIVED if has_energy else STATUS_MISSING, "Power telemetry",
        None if has_energy else no_data_note,
    )
    indicators["pue"] = _indicator(
        "pue", "Power Usage Effectiveness", "ratio", "E_DC / E_IT",
        round(e_dc / e_it, 3) if has_energy else None,
        STATUS_DERIVED if has_energy else STATUS_MISSING, "Power telemetry",
        None if has_energy else no_data_note,
    )
    indicators["water_l"] = _indicator(
        "water_l", "Water consumption", "L", "facility energy x reference water intensity by cooling type",
        round(water_l, 2) if has_energy else None,
        STATUS_ESTIMATED if has_energy else STATUS_MISSING, "Reference water factors",
        "No water meter exists. Modelled from placeholder industry-average factors."
        if has_energy else no_data_note,
    )
    indicators["wue"] = _indicator(
        "wue", "Water Usage Effectiveness", "L/kWh", "W_IN / E_IT",
        round(water_l / e_it, 3) if has_energy else None,
        STATUS_ESTIMATED if has_energy else STATUS_MISSING, "Reference water factors",
        "Numerator is modelled water, not a metered value." if has_energy else no_data_note,
    )
    indicators["scope2_kg"] = _indicator(
        "scope2_kg", "Scope 2 emissions, location-based", "kg CO2e", "E_DC x grid emission factor",
        round(e_dc * ef, 2) if has_energy else None,
        STATUS_ESTIMATED if has_energy else STATUS_MISSING, settings.emission_factor_source,
        "Grid-average factor, not a supplier-specific or market-based one." if has_energy else no_data_note,
    )
    indicators["scope1_kg"] = _indicator(
        "scope1_kg", "Scope 1 emissions", "kg CO2e", "on-site fuel combustion",
        None, STATUS_MISSING, "Not tracked",
        "GreenOps does not track on-site fuel use such as backup generators.",
    )

    if settings.renewable_energy_factor is not None:
        indicators["ref"] = _indicator(
            "ref", "Renewable Energy Factor", "fraction", "E_RES / E_DC",
            round(settings.renewable_energy_factor, 4), STATUS_DECLARED, "Site settings",
        )
    else:
        indicators["ref"] = _indicator(
            "ref", "Renewable Energy Factor", "fraction", "E_RES / E_DC",
            None, STATUS_MISSING, "Site settings",
            "Cannot be derived from telemetry. Needs metered renewable supply, declared by the operator.",
        )

    if settings.energy_reuse_factor is not None:
        indicators["erf"] = _indicator(
            "erf", "Energy Reuse Factor", "fraction", "E_REUSE / E_DC",
            round(settings.energy_reuse_factor, 4), STATUS_DECLARED, "Site settings",
        )
    else:
        indicators["erf"] = _indicator(
            "erf", "Energy Reuse Factor", "fraction", "E_REUSE / E_DC",
            None, STATUS_MISSING, "Site settings",
            "Cannot be derived from telemetry. Needs metered reused heat, declared by the operator.",
        )

    return {
        "period": {"days": days, "from": cutoff.isoformat(), "to": now.isoformat()},
        "indicators": indicators,
        "observed_peak_it_kw": round(observed_peak_kw, 2),
        "settings": settings,
    }


# ---------------------------------------------------------------------------
# Framework evaluation
# ---------------------------------------------------------------------------

def evaluate_framework(db: Session, framework_id: str, days: int = 30):
    """Readiness report for one framework, or None for an unknown id."""
    framework = FRAMEWORKS.get(framework_id)
    if framework is None:
        return None

    computed = compute_indicators(db, days)
    settings = computed["settings"]
    rows = [computed["indicators"][indicator_id] for indicator_id in framework["indicators"]]

    by_status = {status: 0 for status in (*AVAILABLE_STATUSES, STATUS_MISSING)}
    for row in rows:
        by_status[row["status"]] += 1
    available = sum(by_status[status] for status in AVAILABLE_STATUSES)

    in_scope = None
    if framework_id == "eu-2024-1364":
        capacity = computed["indicators"]["installed_it_capacity_kw"]
        if capacity["value"] is None:
            in_scope = {
                "applicable": None,
                "reason": "Installed IT capacity is unknown, so applicability cannot be assessed.",
            }
        else:
            applicable = capacity["value"] >= EU_REPORTING_THRESHOLD_KW
            basis = "declared" if capacity["status"] == STATUS_DECLARED else "observed peak"
            in_scope = {
                "applicable": applicable,
                "reason": (
                    f"IT power demand of {capacity['value']:.1f} kW ({basis}) is "
                    f"{'at or above' if applicable else 'below'} the "
                    f"{EU_REPORTING_THRESHOLD_KW:.0f} kW reporting threshold."
                ),
            }

    caveats = [
        "Water and emissions use reference factors, not meters or supplier data.",
        "No independent assurance has been performed on any value.",
    ]
    if settings.telemetry_simulated:
        caveats.insert(0, "Telemetry in this deployment is simulated, not read from real equipment.")

    return {
        "framework": {
            "id": framework_id,
            "name": framework["name"],
            "reference": framework["reference"],
            "jurisdiction": framework["jurisdiction"],
            "scope_note": framework["scope_note"],
        },
        "period": computed["period"],
        "in_scope": in_scope,
        "indicators": rows,
        "readiness": {
            "total": len(rows),
            "available": available,
            "missing": by_status[STATUS_MISSING],
            "percent": round(100 * available / len(rows)) if rows else 0,
            "by_status": by_status,
        },
        "provenance": {
            "emission_factor_kg_per_kwh": settings.grid_emission_factor_kg_per_kwh,
            "emission_factor_source": settings.emission_factor_source,
            "water_intensity_l_per_kwh": dict(rules_engine.WUE_FACTORS),
            "telemetry_simulated": bool(settings.telemetry_simulated),
        },
        "alignment_note": (
            "These values show that GreenOps calculates each indicator using the framework's "
            "own definition. They are not a compliance declaration. " + " ".join(caveats)
        ),
    }
