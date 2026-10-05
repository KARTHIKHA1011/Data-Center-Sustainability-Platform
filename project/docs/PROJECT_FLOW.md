# GreenOps — Full Project Flow, In Detail

A complete, ground-up walkthrough of how GreenOps actually works: every input, every formula, every decision point, from telemetry generation to the number an operator sees on screen. Written to be read start to finish, not skimmed.

---

## 1. What this system is, in one sentence

GreenOps watches four streams of data center telemetry, uses simple explainable rules to spot waste, uses two families of machine learning models to forecast and validate behavior, simulates the consequence of consolidating workloads before anything happens, and hands a human a ranked list of recommendations with honest, itemized impact estimates — never executing anything itself.

Mental model: **OBSERVE → ANALYZE → PREDICT → EVALUATE → RECOMMEND**

---

## 2. The data layer — where every number originates

### 2.1 Four simulators, one HTTP contract

Nothing in this system reads real hardware. Four independent Python scripts each generate one telemetry domain and `POST` it to the FastAPI backend every 15 seconds, per server, forever:

| Simulator | Posts to | Fields |
|---|---|---|
| `server_monitor.py` | `/telemetry/server` | `cpu_utilization`, `memory_utilization`, `network_throughput_gbps`, `workload_intensity` |
| `power_monitor.py` | `/telemetry/power` | `it_power_kw`, `facility_power_kw` |
| `cooling_monitor.py` | `/telemetry/cooling` | `inlet_temperature_c`, `cooling_efficiency`, `cooling_type` |
| `storage_monitor.py` | `/telemetry/storage` | `total_storage_gb`, `used_storage_gb`, `duplicate_data_gb`, `last_accessed_days_ago` |

Thirteen servers exist (`S1`–`S13`), each with a fixed identity assigned at registration and never changed at runtime:

| Server | Type | Cooling | Region | Workload bias |
|---|---|---|---|---|
| S1 | Compute | Air | APAC | 0.65 |
| S2 | Compute | Air | APAC | 0.60 |
| S3 | GPU | Hybrid | EU | 0.30 |
| S4 | Storage | Liquid | ME | 0.15 (idle) |
| S5 | Edge | Air | APAC | 0.12 (idle) |
| S6 | Compute | Air | APAC | 0.05 (very idle) |
| S7 | GPU | Hybrid | EU | 0.55 |
| S8 | GPU | Hybrid | EU | 0.10 (idle) |
| S9 | Storage | Liquid | ME | 0.45 |
| S10 | Storage | Liquid | ME | 0.14 (idle) |
| S11 | Edge | Air | APAC | 0.50 |
| S12 | Edge | Air | APAC | 0.16 (idle) |
| S13 | Compute | Air | ME | 0.70 |

`cooling_type` and `datacenter_region` are drawn from the exact vocabulary the ML training dataset uses (`Air`/`Hybrid`/`Liquid`, `APAC`/`EU`/`ME`) — this matters later (§6.3).

### 2.2 The exact generating formulas, as they exist today

**`server_monitor.py`** — the one true independent random source per server:
```
workload = clamp(0.02, 0.98, gauss(bias, 0.08))
cpu      = clamp(1, 99, workload * 100 + uniform(-5, 5))
memory   = clamp(5, 99, cpu * 0.9 + uniform(-8, 8))
network  = max(0.1, workload * 25 + uniform(-2, 2))
```
Note: `memory` and `network` are *derived from* `cpu`/`workload`, not independent signals — they carry no information `cpu` doesn't already contain.

**`power_monitor.py`** — reads each server's *live* CPU/memory (one `GET /servers` call per cycle) before generating:
```
cpu_fraction    = clamp(0, 1, cpu / 100)
memory_fraction = clamp(0, 1, memory / 100)
variable_kw     = 3.3 * (0.85 * cpu_fraction + 0.15 * memory_fraction)
it_power_kw     = max(0.3, 1.2 + variable_kw + uniform(-0.15, 0.15))

# PUE side -- reads each server's live cooling_efficiency too
penalty_fraction = (0.99 - cooling_efficiency) / (0.99 - 0.4)
overhead_ratio    = max(1.05, 1.15 + 0.40 * penalty_fraction + uniform(-0.03, 0.03))
facility_power_kw = it_power_kw * overhead_ratio
```
So `it_power_kw` is a real function of load, and `facility_power_kw ÷ it_power_kw` (= PUE) is a real function of cooling efficiency — neither was true before this project's most recent fixes; both used to be pure `random.uniform(...)`.

**`cooling_monitor.py`** — also reads each server's live CPU:
```
cpu_fraction = clamp(0, 1, cpu / 100)

temp_rise_by_type       = {Air: 9.0, Hybrid: 5.0, Liquid: 2.5}   # °C at 100% CPU
efficiency_drop_by_type = {Air: 0.35, Hybrid: 0.20, Liquid: 0.10}

inlet_temperature_c = 19.0 + temp_rise_by_type[type] * cpu_fraction + uniform(-0.8, 0.8)
cooling_efficiency  = clamp(0.4, 0.99, 0.95 - efficiency_drop_by_type[type] * cpu_fraction + uniform(-0.03, 0.03))
```
Air-cooled servers heat up fastest and lose efficiency fastest under load; Liquid barely moves; Hybrid sits between. This causal direction only runs **load → environment**, never the reverse — a real cooling *fault* (independent of load) has no way to happen in this simulator (see §6.4 for why that matters).

**`storage_monitor.py`** — capacity/staleness/duplication metadata only, never file contents. Mirrors what a real storage-optimization tool (e.g. AWS S3 Storage Lens) is actually given access to.

### 2.3 Ingestion

FastAPI validates every POST against a Pydantic schema, writes it to Postgres (or SQLite, see §9), and silently drops an exact-duplicate delivery from the same server within 2 seconds (`_is_duplicate_reading()`) so a network retry never double-counts.

---

## 3. The rule engine — waste detection, zero ML

Four checks, each simple enough to verify by hand, run continuously against the latest telemetry:

| Flag | Rule |
|---|---|
| `idle_server` | 6-hour average CPU < that server type's threshold |
| `stale_data` | `last_accessed_days_ago` > 90 |
| `duplicate_data` | `duplicate_data_gb ÷ total_storage_gb` > 20% |
| `overprovisioned` | `used_storage_gb ÷ total_storage_gb` < 30% |

**Per-type idle thresholds** are derived once from the real Kaggle dataset (`compute_thresholds.py`), not guessed:
```
threshold = mean_cpu(type) - 1.5 * std_cpu(type)     # clamped to [5, 35]
severity_weight = avg_power_kw(type) / min(avg_power_kw across all types)
```
Real computed values:

| Type | Threshold | Severity weight |
|---|---|---|
| GPU | 16.9% | 1.66× |
| Compute | 17.3% | 1.22× |
| Storage | 16.8% | 1.06× |
| Edge | 18.9% | 1.0× (baseline) |

A flag that stops being true gets resolved the same cadence it was raised — nothing accumulates forever. `sync_recommendations()` also withdraws any pending `Recommendation` whose underlying `Flag` is no longer active, so flapping idle/healthy/idle doesn't pile up stale duplicates.

---

## 4. Sustainability metrics — what's real, what's estimated

| Metric | Formula | Trust level |
|---|---|---|
| **PUE** | `facility_power_kw ÷ it_power_kw` | The one number here that's a genuine ratio of two directly-simulated values |
| **Energy (kWh)** | True timestamp integration — for each server, sum `power_kw × actual_hours_elapsed` between consecutive readings, skipping gaps > 5 min | Correct as of this project's fix (previously assumed 1 reading = 1 minute, overcounting ~4×) |
| **Cost** | `energy_kwh × ₹8.0/kWh` (placeholder) | Estimate |
| **Carbon** | `energy_kwh × 0.5 kg/kWh` (placeholder) | Estimate |
| **Total water (L)** | Cumulative `energy_kwh × WUE_FACTOR[cooling_type]` per server, summed since telemetry began | Estimate, a running total — expected to keep climbing |
| **WUE (L/kWh)** | Same weighted calc, but windowed to the last hour | Estimate, a real ratio in shape |

`WUE_FACTORS = {Air: 0.3, Hybrid: 1.8, Liquid: 0.9}` L/kWh — industry-average placeholders, keyed by the *categorical* `cooling_type`, never by the numeric `cooling_efficiency` reading. Water is always computed via `CPU/workload → power → energy → × WUE factor`, never derived straight from CPU.

In production, cost/carbon/WUE would be replaced by a real tariff, a live grid carbon-intensity API, and a real facility water meter.

---

## 5. The two ML validation models

Both trained once, offline, by `train_model.py`, on `green_ai_datacenter.csv` — a real, static, 10,000-row Kaggle dataset. **Never on live simulator output** — the two pipelines (live telemetry, ML training data) share only a schema, never an origin.

### 5.1 Shared preprocessing
```
numeric      -> StandardScaler()
categorical  -> SimpleImputer(most_frequent) -> OneHotEncoder(handle_unknown="ignore", drop="first")
```
`drop="first"` matters: without it, one-hot-encoding every category plus an intercept creates a perfectly collinear matrix, which once made `LinearRegression`'s coefficients numerically explode (a real, caught, fixed bug).

### 5.2 CPU model
- **Target:** `cpu_utilization`
- **Inputs:** `workload_intensity, memory_utilization, network_throughput_gbps, inlet_temperature_c, cooling_efficiency, pue` + categoricals `server_type, cooling_type, datacenter_region, time_of_day`
- **Deliberately excludes its own target** — including it would be leakage
- **Result:** MAE 4.51 / RMSE 7.67 / **R² 0.845**

### 5.3 Power model
- **Target:** power, rescaled from the dataset's 28–233 kW range down to this project's live 1.2–4.5 kW range (`rescale_power_target()`) — a pure unit change, confirmed by identical R² before/after
- **Inputs:** the same six numeric + four categorical, **plus `cpu_utilization`** — legitimate here since CPU isn't the target
- **Result:** MAE 0.211 / RMSE 0.330 / **R² 0.422** — noticeably weaker than CPU, a real and expected finding, not a bug

### 5.4 Model selection
Three candidates trained for each target — `LinearRegression()`, `RandomForestRegressor(200 estimators)`, `XGBRegressor(200 estimators, depth 5)` — on an 80/20 split. **Selection rule:** lowest MAE wins, but RF/XGBoost must beat Linear Regression by ≥5% relative MAE to be chosen over it. On this dataset, **Linear Regression wins both targets** — the promotion bar was set before results were seen, and nothing cleared it.

### 5.5 What these models are actually for, today

`GET /servers/{id}/prediction` builds a live feature row and returns `measured_cpu`, `predicted_cpu`, `absolute_error` — that endpoint exists and works exactly as designed. **But nothing in the running frontend currently calls it.** The only place either model's result is actually visible today is the static offline MAE/RMSE/R² table on the Model Evaluation page (read once from a JSON file written at training time, never recomputed live). Their real, current role is a **completed offline validation result** — proof the chosen feature set explains real server behavior — not a live decision-maker anywhere in the app.

Their designed future role is a **hardware/environment health check**: compare what CPU *should* be, given current conditions, against what it *actually* is, on an ongoing basis, to catch a server behaving inconsistently with its own environment (failing fan, misbehaving process, degrading cooling) — the same way an unexpected drop in a car's fuel efficiency at a given speed signals a mechanical problem. **Not built yet.** It needs two things first: real telemetry (or the categorical/simulator-realism fixes already done, see §6.3–6.4), and — the deeper blocker — a way for an environmental fault to actually happen in the simulator, since right now causality only runs load→environment, never the reverse, so nothing would ever diverge for the check to catch.

Two other roles for these models were considered and explicitly rejected: using a snapshot prediction as a forecast fallback (risks masking a real telemetry outage behind a plausible number), and using the model to detect *interaction effects* between features for a third consolidation safety check (impossible for this specific model — a plain additive Linear Regression, with no interaction terms, cannot represent "this combination of features is riskier together" no matter how clean the data is).

---

## 6. Workload forecasting — three honest tiers

`forecasting.py` answers one question per tier: *given this server's history, what will its CPU likely be?* Two structurally different forecast jobs live in this file, and they must not be confused with each other.

### 6.1 Operator-facing forecast (`forecast_server()`, Server Detail page)

Gated to servers currently flagged idle (same 6h rule as §3). Three horizons, each handled by the right method for its range, not one method forced onto all three:

- **1 hour** — its own trained lagged-feature model. Features: `cpu_lag_5m, cpu_lag_10m, cpu_lag_15m, cpu_lag_20m, avg_cpu_last_hour, memory_utilization, workload_intensity, network_throughput_gbps, hour_sin, hour_cos`. Falls back to short-horizon trend extrapolation until ≥30 real lagged samples exist.
- **6 hours / 24 hours** — deliberately **no trained model**. Two reasons: not enough real history exists yet at that range, and each server's workload here is generated from a fixed `bias` that never drifts or cycles — the honest estimate for a near-stationary series that far out is reversion to its own recent average, not a straight-line extrapolation (which would badly overshoot). `long_horizon_forecast()` averages telemetry across whatever real coverage exists in the window and **refuses to answer** — returns "not enough history," not a guess — unless real coverage reaches at least half the requested window with ≥10 samples.

### 6.2 Consolidation safety forecast (`forecast_candidate_server()`, internal only)

A completely separate, untouched 15-minute-horizon model (`FORECAST_HORIZON_MINUTES = 15`), always called with no horizon argument by `recommendations.py`. Mirror-image eligibility rule from §6.1: runs on **any** registered server, no idle gate — because a consolidation *target* is by definition not idle, so it could never pass the idle-only gate. Reuses the exact same CPU-lag architecture (never actually restricted to idle servers at training time), plus a second, independently-trained **memory** forecast model, since the safety check needs both dimensions.

### 6.3 The distribution-shift caveat, stated plainly

Live prediction errors, for any of these models, will typically run higher than the reported offline MAE. The models train on real historical relationships; live data comes from simulators using their own simpler generating formulas. This is a genuine, expected train/inference gap, not a bug.

---

## 7. The recommendation engine — from flag to ranked decision

### 7.1 Flag → recommendation mapping
```
idle_server      -> consolidate
stale_data       -> archive
duplicate_data   -> deduplicate
overprovisioned  -> rightsize
```

### 7.2 Consolidation what-if — the real simulation

For `idle_server` flags specifically, `GET /recommendations/{id}/what-if` runs an actual simulation, not a source-only guess:

**Step 1 — find every candidate.** Every same-`server_type` server that isn't itself idle-flagged.

**Step 2 — compute post-move load for each candidate**, using a 0.9 overhead factor:
```
post_move_cpu     = target.current_cpu    + source.current_cpu    * 0.9
post_move_memory  = target.current_memory + source.current_memory * 0.9
post_move_network = target.current_network + source.current_network * 0.9
```

**Step 3 — four-dimension safety check per candidate**, all must pass for `safe_now`:
| Dimension | Limit | Basis |
|---|---|---|
| CPU | < 75% | `SAFETY_LIMIT_PERCENT` |
| Memory | < 75% | `SAFETY_LIMIT_PERCENT` |
| Network | < 18.75 Gbps | 75% of an assumed 25 Gbps NIC (`NETWORK_CAPACITY_GBPS`) |
| Thermal | predicted post-move inlet temp < 30°C | reuses `cooling_monitor.py`'s own load→temperature formula (§2.2), driven by `post_move_cpu`, since temperatures can't simply be summed across two servers |

**Step 4 — the forecast check.** Independently, the candidate's *own* near-term CPU/memory forecast (§6.2, 15 minutes out) is checked against the same CPU/memory limits — `safe_forecast`. A candidate only counts as fully `safe` when `safe_now AND safe_forecast` — this catches a target that looks fine right now but is about to get busy on its own. Network and thermal have **no forecast counterpart** (no trained model exists for either), so they're always current-snapshot-only checks.

**Step 5 — pick the winner.** The top-ranked *safe* candidate (safe-first, then most headroom left) becomes the recommended target. If none qualify, the recommendation is explicitly `"safe": false` with a stated reason — never silently approved. All candidates considered (top 5) are exposed in the response so an operator can see what else was looked at, not just the winner.

**Step 6 — the impact estimate.** Prefers the trained power model's prediction for the target's full post-move profile (CPU, memory, network, cooling), scaled to facility power by the target's current PUE — falls back to a simpler CPU-ratio formula only if the model or the target's cooling telemetry is unavailable. Every use of the power model is stated explicitly in the response's `assumptions` list, including the honest caveat that this is a legitimate estimate, not a measurement (the model learned from different, real servers than the ones being simulated here).

**What "safe" still does *not* check:** target storage capacity (consolidation never touches storage — that's a separate action type) and electrical/PDU capacity (no modeled ceiling exists). Criticality/SLA gating is a separate, long-standing, deliberately unbuilt gap — telemetry alone can't tell you which workloads matter, and nothing here pretends otherwise.

### 7.3 Ranking pending recommendations

```
score = Σ(weight_i × normalized_impact_i) − risk_weight × risk
```
Normalized against the max of each dimension in the current pending batch, so kWh/₹/kg/L don't dominate each other by raw magnitude. Weights (`energy_weight, cost_weight, carbon_weight, water_weight, risk_weight`) live in a single-row, organization-configurable `Preferences` table, editable via the Preferences page — changing them re-ranks instantly, nothing retrains. Risk for consolidation = `max(post_move_cpu, post_move_memory) ÷ 75`; for storage-only actions (no target, no power effect) it's a fixed `0.1`.

---

## 8. Operator decisions and the audit trail

An operator (role: `infrastructure_manager`) can `consolidate` (or the generic `rightsize` verb for archive/dedupe), `snooze`, or `do_nothing` on any pending recommendation. Every decision **snapshots the what-if impact at the moment it was made** into `OperatorAction` — the ESG report reads that frozen snapshot, not a live recalculation, so the log reflects exactly what the operator actually saw. Snoozing sets `snoozed_until`; once that passes, the recommendation quietly returns to `pending` rather than being lost.

**Approved Actions page** — the one narrow exception to "GreenOps has no way to verify anything happened." `executed_at`/`execution_note`, settable only via `PATCH /operator-actions/{id}`, let an operator manually attest *after the fact* that a consolidation actually happened. This is attestation, not verification — there's still no automatic confirmation mechanism anywhere.

**ESG report** — aggregates those `OperatorAction` snapshots over a date range: decision counts and summed estimated impact. Explicitly a decision log, not a verified-savings report.

---

## 9. Role-based access control

Three roles, enforced both server-side (`require_role()` dependency on every mutating endpoint) and client-side (route guards, conditional nav):

| Role | Can do |
|---|---|
| `infrastructure_manager` | Everything — accept/snooze/dismiss, edit Preferences, manage users |
| `sustainability_manager` | Read-only — dashboards, ESG report |
| `operations_engineer` | Mark approved actions executed (`PATCH /operator-actions/{id}`) — cannot make the original accept/snooze/dismiss decision |

JWT-based login (`/auth/login`), seeded via `backend/seed_users.py`.

---

## 10. Database and persistence

Postgres in this deployment (`greenops_user`/`greenops_db`), SQLite by default with zero code change (`DATABASE_URL` env var, read by `database.py`). Schema changes now go through **Alembic** (adopted this session), baselined onto the already-existing schema via `alembic stamp head`.

Eleven tables: `users`, `servers` (static metadata), four raw telemetry tables (`server_telemetry`, `power_telemetry`, `cooling_telemetry`, `storage_telemetry`), `forecasts` (persisted forecast audit log), `flags`, `recommendations`, `operator_actions`, `preferences`.

---

## 11. Frontend

React + Vite + `react-router-dom` + `recharts`. No gauges or progress bars anywhere — every metric card states a colored verdict pill plus a plain-English relationship sentence instead. Pages: **Overview**, **Servers**, **Server Detail** (CPU history, workload projection, environmental impact, storage, active flags), **Storage**, **Analytics**, **Model Eval** (offline ML metrics, hidden from the operational nav — not operator-facing content), **Recommendations** (card-based list with inline decisions and a "Target forecast (CPU)" indicator), **Recommendation Detail** (full ranked candidate table, impact breakdown, decision buttons), **Approved Actions**, **Preferences**, **Reports** (ESG), **Login**, **User Management**.

---

## 12. What's real, what's estimated, what's deliberately not built — the honest summary

**Genuinely real:** the rule engine (pure threshold logic, no ML), PUE (a direct ratio of two simulated numbers), the offline ML validation results (R² 0.845 / 0.422, honestly reported), the timestamp-based energy integration, the four-dimension consolidation safety check.

**Legitimate estimates, clearly labeled as such:** cost, carbon, water, the power model's what-if energy prediction (agrees on direction and scale with the simulator, won't match exactly — two independently-built approximations of the same idea).

**Deliberately not built, not by oversight:** criticality/SLA gating, target storage-capacity and electrical-capacity safety checks, a verified (not just attested) savings mechanism, the CPU model's hardware health-check role (needs simulator fault-injection first), 6h/24h trained forecast models (not enough real history yet).

**The one rule underneath all of it:** GreenOps recommends and estimates. It never executes an infrastructure change by itself, and never will.
