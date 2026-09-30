# GreenOps — Intelligent Data Center Resource Optimization & Sustainability Management

Submission for **IPS12: Intelligent Data Center Resource Optimization and
Sustainability Management Platform**.

Data centers can see *what's happening* (CPU%, PUE) but nothing tells them
*what to do about it*. GreenOps is a resource intelligence and
sustainability decision-support layer that sits **above** existing
monitoring tools (it doesn't replace them). It observes four telemetry
domains, detects waste with explainable rules, forecasts near-term demand,
simulates and ranks consolidation/storage recommendations, and estimates
their energy/cost/carbon/water impact — with a human always approving
before anything happens.

**Not an autoscaler.** GreenOps never controls infrastructure
automatically, and never will — every recommendation is reviewed and
accepted/snoozed/dismissed by an operator.

**Mental model:** `OBSERVE → ANALYZE → PREDICT → EVALUATE → RECOMMEND`

---

## Status

Phase 1 and Phase 2 are built and run end to end against live telemetry:

- Rule-based waste detection (idle servers, stale/duplicate/over-provisioned storage)
- Per-server-type, dataset-derived idle thresholds
- Two ML validation models (CPU + power estimation) trained on a real Kaggle dataset
- Near-term CPU/memory forecasting (lagged-feature model, honest trend fallback)
- Real what-if simulation for consolidation: ranks every same-type candidate,
  gates on CPU, memory, network throughput, and predicted thermal impact —
  both for the current snapshot and each candidate's own forecast, **and**
  the source server's own forecast (not just the target's)
- Weighted, configurable recommendation ranking
- Operator decisions (accept / snooze / dismiss) with full audit trail,
  including who decided and their role
- Manual "approved actions" attestation (mark a decision as actually executed)
- ESG decision-log report with CSV export
- Compliance-readiness panel — indicative alignment with the EU Delegated
  Regulation (EU) 2024/1364 data-centre indicators and SEBI BRSR Core,
  never described as "compliant" or "certified"
- Role-based access control (infrastructure manager / sustainability manager
  / operations engineer), JWT auth

**Deliberately not built**, named rather than hidden:

- **Criticality / SLA gating** — telemetry can't tell you *why* a server
  matters, only *how hard* it's working, so nothing here gates a
  recommendation on business criticality.
- **Target storage capacity / electrical capacity** as a consolidation
  safety check — "safe" currently means CPU, memory, network, and thermal.
- Any automatic execution of a recommendation, ever.

---

## Architecture

```
4 simulators (server / power / cooling / storage), each posting JSON every 15-30s
        |  HTTP POST
   FastAPI (Pydantic validation)
        |
   SQLAlchemy -> PostgreSQL
        |
  +-----------+--------------+---------------+
  |           |              |               |
Rule engine  Forecasting   ML validation   Compliance /
(no ML)      (lagged CPU/  models (CPU +   ESG layer
             memory model) power estimate)
  |           |              |               |
  +-----------+--------------+---------------+
                     |
        Recommendation engine (rank, what-if
        simulation, safety gates)
                     |
          React dashboard (role-aware)
```

**Two pipelines never touch each other.** Live telemetry is 100% simulated
(no real data-center access was available for this project) — the ML
models train on a real, static, 10,000-row Kaggle dataset
(`green_ai_datacenter.csv`), never on simulator output. They're connected
only by matching schema. The dashboard never shows "real" readings, and the
ML models never learned from the live simulators.

---

## How to run it

```bash
# Backend
cd backend
python -m venv venv && source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt
python -m app.compute_thresholds     # one-time: derive per-type idle thresholds from the dataset
python -m app.train_model            # one-time: train CPU + power models (~15s)
alembic upgrade head                 # apply schema migrations
uvicorn app.main:app --reload --env-file .env    # API at http://localhost:8000

# Simulators (each in its own terminal — all 4 needed for live-updating data)
cd simulators
python server_monitor.py
python power_monitor.py
python cooling_monitor.py
python storage_monitor.py

# Frontend
cd frontend
npm install
npm run dev                          # UI at http://localhost:5173
```

`backend/.env` holds `DATABASE_URL` for a local PostgreSQL database.
`database.py` reads it automatically — swapping databases is a one-line
env-var change, no code change. Seed the three role accounts with
`python -m app.seed_users` (from `backend/`).

**Schema changes go through Alembic**, not manual `ALTER TABLE`:

```bash
alembic revision --autogenerate -m "describe the change"
alembic upgrade head
```

---

## The four telemetry domains

| Domain | Simulator | Fields posted | Feeds into |
|---|---|---|---|
| Server | `server_monitor.py` | CPU, memory, network throughput, workload intensity | Idle-server flag, ML model inputs, forecasting |
| Power | `power_monitor.py` | IT power, facility power | PUE = facility ÷ IT; feeds energy → cost → carbon → water |
| Cooling | `cooling_monitor.py` | inlet temperature, cooling efficiency, cooling type | WUE factor lookup, thermal safety gate |
| Storage | `storage_monitor.py` | total/used/duplicate storage, last-accessed age | stale / duplicate / over-provisioned flags |

Detection is deliberately **rule-based, not ML** — explainable, no training
data required on day one:

| Flag | Rule |
|---|---|
| `idle_server` | avg CPU over last 6h below that server type's dataset-derived threshold |
| `stale_data` | not accessed in over 90 days |
| `duplicate_data` | duplicate data exceeds 20% of total storage |
| `overprovisioned` | used storage below 30% of total capacity |

Per-type idle thresholds (`threshold = mean_cpu − 1.5×std_cpu`, clamped to
`[5, 35]`), computed once from the real dataset:

| Type | Threshold | Severity weight |
|---|---|---|
| GPU | 16.9% | 1.66x |
| Compute | 17.3% | 1.22x |
| Storage | 16.8% | 1.06x |
| Edge | 18.9% | 1.0x (baseline) |

---

## Sustainability metrics — trust levels

| Metric | Basis | Trust level |
|---|---|---|
| PUE | `facility_power ÷ it_power` | Real ratio of two simulated numbers — the one figure here that's genuinely "physical" |
| Energy (kWh) | True timestamp-based integration of power readings | Correct given simulated input |
| Cost | Energy × a fixed tariff placeholder | Estimate |
| Carbon | Energy × a sourced emission factor (default: CEA India FY2024-25 grid average, editable) | Estimate, but sourced, not arbitrary |
| Water (total + WUE rate) | Energy × per-cooling-type WUE factor, weighted per server | Estimate, built on published factors, not a meter |

In production, cost/carbon/water would be replaced by a real tariff, a live
grid carbon-intensity API, and an actual facility water meter.

---

## The two ML models

Both trained on the real Kaggle "Green AI Data Center Telemetry" dataset
(10,000 rows), never on live simulator output.

| | CPU model | Power model |
|---|---|---|
| Target | CPU utilization | Power draw (rescaled to live IT-power range) |
| Role | Offline validation — proves the feature set explains CPU behavior | Primary basis for the what-if engine's energy estimate |
| R² | ≈ 0.845 | ≈ 0.42 |

Selection rule: lowest MAE wins, but Random Forest / XGBoost must beat
Linear Regression by ≥5% relative MAE to be chosen over it — on this
dataset, Linear Regression wins both targets. Expect live prediction error
to run higher than the offline MAE: the simulators generate telemetry with
their own simplified formulas, a genuine train/inference distribution
shift, not a bug.

---

## Frontend

React + Vite + `react-router-dom` + `recharts`. Pages: Overview, Servers,
Server Detail, Storage, Analytics, Model Evaluation, Recommendations (list)
+ Recommendation Detail, Approved Actions, Preferences, Reports (ESG +
compliance readiness), User Management, Login.

- Verdict pills + plain-English relationship text instead of gauges/rings/
  progress bars.
- Role-aware navigation and route guards (infrastructure manager,
  sustainability manager, operations engineer).

---

## Project structure

```
backend/
  .env                      # DATABASE_URL — never commit real credentials elsewhere
  alembic/                  # schema migrations
  app/
    main.py                 # FastAPI app, all endpoints
    models.py                 # SQLAlchemy tables
    schemas.py                  # Pydantic validation
    database.py                   # Postgres connection, swappable via DATABASE_URL
    rules_engine.py                 # Idle/storage rules, PUE/WUE/energy math, per-type thresholds
    compliance.py                     # Compliance-readiness layer (EU 2024/1364, BRSR Core)
    recommendations.py                  # Flag -> recommendation mapping, what-if simulation, ranking
    forecasting.py                        # Near-term CPU/memory forecasting
    auth.py                                 # JWT auth, role guards
    train_workload_forecast.py                # Trains forecast models from real DB telemetry
    compute_thresholds.py                       # Derives per-type idle thresholds from the dataset
    train_model.py                                # Trains CPU + power validation models
    data/                                           # Real Kaggle dataset + derived thresholds
    ml_artifacts/                                     # Generated models + metrics
  requirements.txt
simulators/
  server_monitor.py    power_monitor.py    cooling_monitor.py    storage_monitor.py
frontend/
  src/
    api.js    App.jsx    Layout.jsx    AuthContext.jsx    index.css
    pages/
      Overview.jsx    Servers.jsx    ServerDetail.jsx    Storage.jsx
      Analytics.jsx    ModelEval.jsx    Login.jsx    UserManagement.jsx
      Recommendations.jsx    RecommendationDetail.jsx    ApprovedActions.jsx
      Preferences.jsx    Reports.jsx
frontend-static-legacy/     # old single-file HTML dashboard, reference only
docs/
  diagrams/     # activity diagrams, DFD, ER diagram
  CLAUDE.md     # full technical project brief — source of truth for design decisions
```

---

## Non-negotiable design decisions

1. Data provenance stays honest: live telemetry is simulated, ML training
   data is real. Never blurred in copy.
2. Per-server-type idle thresholds, never one flat global number.
3. The CPU model excludes its own target from its inputs; the power model
   includes CPU. That asymmetry is intentional.
4. Model selection favors simplicity — a more complex model needs a
   meaningful accuracy edge to be chosen.
5. Water, cost, and carbon are estimates from published or placeholder
   constants — never presented as measured.
6. PUE is the only metric trustworthy as a "real" ratio.
7. No gauges, rings, or progress bars in the UI.
8. Every recommendation is reviewed by a human. Nothing executes
   automatically.

See `docs/CLAUDE.md` for the full technical design history, every bug found
and fixed, and the reasoning behind each of these decisions.
