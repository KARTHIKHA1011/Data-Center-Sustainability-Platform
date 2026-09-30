# Architecture

## System shape

```
4 Simulators (server/power/cooling/storage)
        ↓ HTTP POST, JSON
    FastAPI  (Pydantic validation)
        ↓
    SQLAlchemy ORM
        ↓
    SQLite  (swap to Postgres via DATABASE_URL env var — zero code change)
        ↓
  ┌─────────────┬──────────────┐
  ↓             ↓              ↓
Rule Engine   Analytics     ML Models
(no ML)       (aggregates)  (CPU + Power estimation)
  ↓             ↓              ↓
              React Dashboard (Overview / Servers / Server Detail /
                                Storage / Analytics / Model Eval)
```

This is **Phase 1 only**. There is no forecasting layer, no what-if engine,
and no recommendation engine yet — see `ROADMAP.md`.

## Why this shape

The project deliberately separates concerns that are easy to conflate:

- **Collection vs. storage vs. analysis vs. detection vs. prediction** are
  five different jobs. Only the last one (prediction) needs ML. Detection
  (idle servers, storage waste) is pure rule-based logic — see
  `rules_engine.py` — because rules are explainable and don't need a trained
  model to exist on day one.
- **Historical training data vs. live simulated data are two separate
  pipelines**, connected only by matching schema (same column names/meanings),
  not by shared origin. The ML models train on `green_ai_datacenter.csv` (a
  real, static, 10,000-row dataset). The simulators generate live telemetry
  that the *trained* models are later applied to. Neither pipeline generates
  data for the other.

## Data domains

| Domain | Simulator | Real-world equivalent |
|---|---|---|
| Server | `server_monitor.py` — CPU, memory, network, workload | OS agents, hypervisor APIs, Prometheus node-exporter |
| Power | `power_monitor.py` — IT power, facility power | Smart PDUs, UPS interfaces, BMS power meters |
| Cooling | `cooling_monitor.py` — inlet temp, cooling efficiency, cooling type | CRAC/chiller controllers, BMS sensors |
| Storage | `storage_monitor.py` — capacity, staleness, duplication | Filesystem metadata APIs, storage array tools, cloud storage APIs (e.g. AWS S3 Storage Lens) |

Storage telemetry is metadata only (size, age, checksums) — never file
contents. This mirrors what real storage-optimization tools are actually
given access to in production, and is why storage access is realistically
*easier* to get in a real deployment than people assume.

## The two ML models — what each is actually for

Both are trained in `train_model.py` from the same real dataset,
`green_ai_datacenter.csv` (10,000 rows, 4 `server_type` categories: Compute,
Edge, GPU, Storage; one real data-quality issue — 3,990 missing
`datacenter_region` values, handled via most-frequent imputation inside the
sklearn Pipeline).

### CPU estimation model
- **Target:** `cpu_utilization`
- **Inputs:** workload_intensity, memory_utilization, network_throughput_gbps,
  inlet_temperature_c, cooling_efficiency, pue, + categoricals (server_type,
  cooling_type, datacenter_region, time_of_day)
- **`cpu_utilization` is deliberately excluded from its own inputs** — target
  leakage.
- **Role:** a *validation layer*. It proves the feature set genuinely
  explains resource behaviour. It is **not** the recommendation engine and
  should never be described as the centerpiece of the project.
- **Real result:** R² ≈ 0.845 (Linear Regression selected).

### Power estimation model
- **Target:** `power_consumption_kw`
- **Inputs:** same as above, **plus `cpu_utilization`** — CPU is a valid
  input here because it is not the target for this model.
- **Role:** this is the model that will matter for Phase 2's what-if engine
  (estimating power draw for a *hypothetical* post-consolidation state).
- **Real result:** R² ≈ 0.39–0.42 across all three algorithms — noticeably
  weaker than the CPU model. **This is an honest finding from the real data,
  not a bug.** It means these features explain CPU well but explain power
  less well — state this plainly if asked, don't paper over it.

### Model selection
Three candidates trained per target: Linear Regression, Random Forest,
XGBoost — evaluated via MAE/RMSE/R² on a held-out 20% test split. See
`DECISIONS.md` for the exact selection rule (it favors simplicity, not just
lowest error).

## Rule-based detection — no ML, by design

`rules_engine.py` implements four checks, all simple threshold logic a human
could verify by hand:

| Flag | Rule |
|---|---|
| `idle_server` | avg CPU over last 6h < that server type's dataset-derived threshold |
| `stale_data` | `last_accessed_days_ago` > 90 |
| `duplicate_data` | `duplicate_data_gb / total_storage_gb` > 20% |
| `overprovisioned` | `used_storage_gb / total_storage_gb` < 30% |

Each idle-server flag also carries a `severity_weight`, scaled to that
server type's average power draw (from the real dataset) — see
`DECISIONS.md` → "Per-server-type thresholds" for why a flat threshold was
replaced.

## Sustainability metrics — computed vs. estimated

| Metric | How it's obtained |
|---|---|
| PUE | `facility_power_kw ÷ it_power_kw` — a real ratio of two directly-simulated numbers |
| WUE / water impact | `energy_kwh × WUE_FACTOR[cooling_type]` — an **estimate** using published industry-average factors (Air 0.3, Evaporative 1.8, Liquid 0.9 L/kWh), since no real water meter exists |
| Energy | `power_kw × time` |
| Cost | `energy_kwh × TARIFF_PER_KWH` (placeholder constant) |
| Carbon | `energy_kwh × CARBON_INTENSITY_KG_PER_KWH` (placeholder constant) |

Never present WUE, cost, or carbon numbers as measured — they are calculated
from assumptions that would be replaced by real regional data in production.

## Frontend

React + Vite + `react-router-dom` + `recharts`, plus a dependency-free set of
visual primitives in `components.jsx` (`RingGauge`, `CapacityBar`,
`Sparkline`, `StatusDot`, `STATUS_COLOR`) used for at-a-glance visual state —
gauges and bars, not just numbers in boxes. `Overview.jsx`, `Servers.jsx`,
and `ServerDetail.jsx` are the reference quality bar; `Storage.jsx`,
`Analytics.jsx`, and `ModelEval.jsx` still need the same visual pass (see
`ROADMAP.md`).

Green color theme: dark forest-green sidebar (`#04342C`), sage page
background (`#F2F8F5`), white cards, `#1D9E75` as the primary accent.
