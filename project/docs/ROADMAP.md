# Roadmap

Everything in this file is **designed but not built**. Nothing here has
code yet unless a section explicitly says otherwise. Listed roughly in
priority order.

---

## 1. UI visual pass for Storage, Analytics, Model Eval (smallest, do this first)

`Overview.jsx`, `Servers.jsx`, and `ServerDetail.jsx` were rebuilt to use
real visual components (`RingGauge`, `CapacityBar`, `Sparkline` from
`components.jsx`) instead of plain metric cards with caption text. The other
three pages still have the older "text + explanation" treatment:

- **`Storage.jsx`** — could use a stacked composition bar showing
  stale/duplicate/over-provisioned GB as proportions of total storage,
  instead of a flat list of flag rows.
- **`Analytics.jsx`** — currently uses plain `recharts` line charts; could
  get gradient-filled area charts (see the `cpuFill` gradient already defined
  in `ServerDetail.jsx` as a pattern to reuse) for visual consistency with
  the rest of the dashboard.
- **`ModelEval.jsx`** — the MAE/RMSE/R² comparison is currently a plain
  table; could get a horizontal bar chart comparing the three algorithms
  visually (see the bar chart built for the presentation deck's Model
  Comparison slide as a reference for the visual shape, though that was
  pptxgenjs, not React).

**Before starting:** read `DECISIONS.md` → "The UI was rebuilt..." section
for the four real bugs that visual rework surfaced last time, so they don't
recur. Screenshot the result with a headless browser before calling it done.

---

## 2. Workload forecasting

**What it needs to answer:** given recent history, what will this server's
CPU/demand likely be in the next 15–60 minutes? Not "what will happen" in
general — just "does the near-term trend look safe to act on."

**Two levels, build the simple one first:**

**Level 1 — trend extrapolation (no ML):**
```
rate_of_change = (latest_reading - reading_n_intervals_ago) / n_intervals
forecast = latest_reading + (rate_of_change × intervals_ahead)
```

**Level 2 — regression using lagged features (same technique as the existing
CPU model, different inputs):**
```
Inputs:  cpu_5min_ago, cpu_10min_ago, cpu_15min_ago, cpu_20min_ago,
         time_of_day, avg_cpu_last_hour
Output:  cpu_15min_from_now
```
Train/evaluate the same way as `train_model.py` — historical sequences,
train/test split, MAE/RMSE/R².

**Honest limitation to preserve in any implementation:** this can only
project continuation of existing patterns (daily cycles, gradual trends). It
cannot predict a one-off event (sudden traffic surge, another server failing
over). This is why a risk engine (below) and human approval must remain even
after a good forecast — never let forecasting alone authorize an action.

---

## 3. What-if simulation engine

**Job:** for each `idle_server` flag, find a safe consolidation target and
estimate the consequence of moving the workload there — without actually
moving anything.

**Algorithm (designed, not built):**
```
1. Candidates = every server NOT currently flagged idle
2. For each candidate, check ALL of:
     post_move_cpu     = target.cpu + source.cpu × overhead_factor   (0.85–0.95)
     post_move_memory   = target.memory + source.memory × overhead_factor
     post_move_network    = target.network + source.network × overhead_factor
   All three must stay under a safety limit (e.g. 75%) — checked against
   BOTH current state and the forecast from item 2 above.
3. Also require: target.server_type == source.server_type (or a defined
   compatibility table), and same datacenter_region (unless the workload is
   explicitly tagged latency-tolerant — not currently modeled).
4. Feed the hypothetical post-move state into the ALREADY-TRAINED power
   model (`power_model.joblib`) to estimate power draw after the move.
5. If multiple targets pass, pick the one with the MOST headroom left over
   afterward — not just the first one that fits.
```

**Honest limitation to preserve:** this assumes the workload is movable at
all. A real system needs a separate "is this workload relocatable" flag from
the ops team — telemetry alone cannot know this. Do not build silent
assumptions that everything is movable.

---

## 4. Sustainability impact + recommendation engine

**Once a what-if candidate exists, compute for it:**
```
Energy saved  = (power_before − power_after) × time_window
Cost saved    = Energy saved × tariff
Carbon avoided = Energy saved × carbon_intensity_factor
Water saved    = Energy saved × WUE_factor[cooling_type]
```

**Then rank candidates:**
```
score = (energy_weight   × energy_saved)
      + (cost_weight     × cost_saved)
      + (carbon_weight   × carbon_avoided)
      + (water_weight    × water_saved)
      − (risk_weight     × risk_score)
```
Weights should be organization-configurable (a future Preferences page), not
hardcoded.

**Important design requirement, explicitly discussed:** energy and water
savings can trade off against each other (a more electricity-efficient
cooling method sometimes uses more water, and vice versa). **Show both
numbers side by side on every recommendation card — do not collapse them
into a single opaque score without also surfacing the raw trade-off.** This
was a specific, deliberate ask — don't lose it in implementation.

**Output shape (designed):**
```
1. Consolidate S4 → S2                    Score: 84
   → Energy saved: 12 kWh | Cost saved: ₹96 | Carbon avoided: 5.2 kg CO2e
   → Water: -0.3 L (uses slightly more, evaporative cooling on S2)
   → Risk: Low
   → Reason: S4 idle 6+ hours, S2 has headroom, forecast shows no near-term spike
```

---

## 5. Criticality / SLA / redundancy gating

**Problem this solves:** a server at 15% CPU could be running a critical
database, backup service, or SLA-bound workload. Telemetry alone cannot
know this — see `DECISIONS.md` for the full reasoning.

**Design:** add a declared (not measured) field per server:
```json
{
  "criticality_tier": "low" | "medium" | "high",
  "sla_tier": "...",
  "redundancy_role": "primary" | "secondary" | "none"
}
```
This should be a **gate before** a consolidation candidate is even proposed
in the what-if engine — not a weighted factor blended into the recommendation
score:
```
IF avg_cpu < threshold
   AND criticality_tier != "high"
   AND redundancy_role != "primary"
   → propose as consolidation candidate
ELSE
   → flag as "idle, but protected — requires manual review"
```
In a real deployment this would come from a CMDB, SLA record, or
orchestration platform tag (Kubernetes labels, VMware tags) — likely data
that already exists elsewhere in the organization for other purposes
(billing, compliance), not something to invent from scratch.

---

## 6. ESG reporting + Preferences page

Lowest priority — depends on everything above existing first.

- **Preferences page:** UI for setting the energy/cost/carbon/water/risk
  weights used in the recommendation engine's scoring formula.
- **ESG report:** aggregated period summary (energy/cost/carbon/water
  totals + accepted recommendations log), exportable — a different artifact
  from the live operational dashboard, meant for compliance/disclosure use.

---

## Explicitly out of scope (do not build)

Carried over from the original problem statement's scope boundary — do not
implement any of these regardless of how reasonable they seem in isolation:

- Automatic server shutdown or workload migration — recommendations only,
  human always approves
- Direct hardware control of any kind
- Full enterprise-wide cloud integration
