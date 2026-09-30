# Decisions

Every entry here was a deliberate choice made after discussion, not a
default. If you're about to change one of these, re-read the rationale
first — there's usually a reason it isn't the "obvious" implementation.

---

## Live telemetry is simulated, not real

**Decision:** `server_monitor.py`, `power_monitor.py`, `cooling_monitor.py`,
`storage_monitor.py` generate realistic synthetic readings rather than
connecting to real infrastructure.

**Why:** No production data-center access is available for this project.

**What this means concretely:** FastAPI receives the same JSON shape whether
it comes from a simulator or a real Prometheus/BMS exporter. Swapping
simulated data for real data later is a **data-source change, not a code
change** — the ingestion layer doesn't know or care where the JSON came
from.

**Do not:** blur this in UI copy or docs by implying the dashboard shows
"real" data-center readings.

---

## ML trains on a real dataset, separate from the live simulators

**Decision:** `train_model.py` loads `green_ai_datacenter.csv` (a real,
10,000-row "Green AI Data Center Telemetry" dataset), not the output of the
live simulators.

**Why:** ML needs months/years of historical examples. A freshly-started
simulator hasn't accumulated that. The dataset and the simulators are
connected only by **matching schema** (same column names/meanings) — not by
shared origin.

**Verification that happened:** When the real dataset was substituted in
place of an earlier synthetic placeholder, the CPU model's real MAE/RMSE/R²
came out to 4.511 / 7.671 / 0.845 — a genuine, reproducible result, not a
number that was invented.

---

## CPU model excludes its own target; power model doesn't

**Decision:** `cpu_utilization` is excluded from the CPU model's own input
features (target leakage). `cpu_utilization` **is** included as an input to
the power model.

**Why:** These are two different questions. "Predict CPU from other signals"
would be circular if CPU were also an input. "Predict power given CPU as one
of the known conditions" is legitimate — CPU is not the target there.

**Do not:** "fix" this by making the two models symmetric. The asymmetry is
correct.

---

## Model selection rule favors simplicity, not just lowest error

**Decision (`select_winner()` in `train_model.py`):** Lowest MAE wins by
default, but Random Forest or XGBoost must beat Linear Regression by **at
least 5% relative MAE improvement** to be selected over it. Otherwise the
simpler model is kept.

**Why:** A 0.5% MAE improvement from XGBoost isn't worth losing
interpretability in front of a panel or an operator. A genuinely large
improvement is a defensible reason to accept more complexity.

**Real outcome:** On this dataset, Linear Regression wins both the CPU
model and the power model — XGBoost and Random Forest were both trained and
compared, but neither cleared the 5% bar.

---

## Idle-server threshold is per-server-type, derived from the dataset — not a flat number

**Decision:** `compute_thresholds.py` computes, per `server_type`:
```
threshold = mean_cpu(type) − 1.5 × std_cpu(type)
```
clamped to `[5, 35]`, plus a `severity_weight = avg_power_kw(type) / min(avg_power_kw across types)`.

**Why the old flat "20% = idle" rule was replaced:** A single global
threshold ignores that different server types have different normal
operating ranges, and that the *cost* of being idle differs by type. The
real dataset shows GPU servers draw ~110 kW on average vs. Edge servers at
~66 kW — an idle GPU server wastes roughly 66% more power than an idle Edge
server at the identical CPU%.

**Real computed values (from the actual dataset):**

| Type | Threshold | Severity weight |
|---|---|---|
| GPU | 16.9% | 1.66x |
| Compute | 17.3% | 1.22x |
| Storage | 16.8% | 1.06x |
| Edge | 18.9% | 1.0x (baseline) |

**Verified behavior:** A GPU server telemetered at 16% CPU (just under its
own 16.9% threshold) was confirmed to produce an `idle_server` flag with
`severity: "high"` and a detail string explaining the 1.66x weighting — this
was tested end-to-end via the API, not just asserted.

**Do not:** reintroduce a single global `IDLE_CPU_THRESHOLD` constant. If a
`server_type` shows up that isn't in the dataset, `_default` (20%, weight
1.0) is the fallback — this is intentional, not a bug to "complete."

---

## WUE and carbon are estimates, explicitly labeled as such

**Decision:** No real facility water meter or live grid carbon-intensity
feed exists. `rules_engine.py` uses fixed `WUE_FACTORS` by cooling type (Air
0.3, Evaporative 1.8, Liquid 0.9 L/kWh — published industry averages).
`main.py` uses a placeholder `CARBON_INTENSITY_KG_PER_KWH` constant.

**Why not derive water from CPU directly:** That skips the real causal
chain. The only defensible path is:
```
CPU/workload → power consumed → energy used → × WUE factor → water impact
```
Never derive water straight from CPU utilization.

**In production, these would be replaced by:** real facility water-meter
readings and a live regional grid carbon-intensity API (e.g. WattTime,
ElectricityMaps) — not by more sophisticated math on the same simulated
inputs.

---

## WUE was mislabeled as a cumulative total, not a rate — fixed

**Decision:** `estimated_water_l` used to be `energy_kwh_since_telemetry_began
× WUE_FACTOR[cooling_type]`, summed per server — a running total that only
ever grew the longer the simulators ran. Real WUE is a **rate** (liters per
kWh, over a time window), not a running total, and should stabilize once the
system reaches steady state. The API and UI now report two separate,
honestly-labeled numbers instead of one ambiguous "WUE":

- `wue_l_per_kwh` — the rate, computed only over the last `WUE_WINDOW_HOURS`
  (default 1h) via `rules_engine.compute_wue_rate()`, using the same
  timestamp-based integration `compute_energy_kwh()` already uses, just
  bounded to a recent window instead of "since telemetry began."
- `total_water_l` — the old cumulative figure, kept (it's a legitimate,
  separate number — "how much water has this run used so far") but no longer
  presented under the "WUE" label.

**What was actually wrong:** not the `WUE_FACTORS` themselves (Air 0.3,
Evaporative 1.8, Liquid 0.9 L/kWh — these were always correct) — only the
numerator/denominator pairing. Dividing a windowed water figure by a windowed
energy figure gives a stable ratio; dividing (or rather, not dividing at all)
a cumulative water figure by nothing just produces a number that climbs
forever.

**Do not:** re-merge these two numbers back into one "WUE" field, and don't
present `wue_l_per_kwh` as more trustworthy than it is — it's still built on
the same placeholder industry-average factors, not a real water meter. PUE
remains the only metric in this project trustworthy as a "real" ratio.

---

## Storage totals were inflated by a join/aggregation fan-out — fixed

**Decision:** `total_storage_gb` and `stale_storage_gb` in `/analytics/summary`
used to be `func.sum()` over the *entire* `storage_telemetry` table (or a join
against it), not each server's latest reading. `storage_monitor.py` reposts
the same fixed capacity per server every ~30s, so summing across all rows
multiplied the real total by however many readings had accumulated — real
capacity is 5,000 GB (S1-S5: 1000+1000+2000+500+500), but the API was
reporting 1,440,000 GB and climbing.

**Fix:** `main.py`'s `_latest_row_per_server()` — a subquery for
`max(timestamp)` grouped by `server_id`, joined back to get exactly one row
per server — then aggregate over that, not the raw table. `total_storage_gb`
now reads 5,000 GB and stays there (a real capacity snapshot doesn't grow
just because more telemetry has been posted).

**Same root cause as the energy-formula and WUE bugs above:** treating a
column that gets reposted unchanged as if summing it over time was
meaningful. Any new aggregate over a telemetry table should ask "am I
summing a *snapshot* value, or something that's genuinely additive over
time (like power → energy)?" before reaching for `func.sum()`.

---

## Flags never auto-resolved — fixed

**Decision:** `Flag.resolved` existed as a column, but nothing ever set it
to `1`. `_upsert_flag()` only created or refreshed a flag when its condition
was true; there was no corresponding path clearing a flag once the condition
stopped being true — a server that recovered from being idle (or stopped
having stale/duplicate/over-provisioned storage) kept its old flag forever,
so `active_flags` only ever grew.

**Fix:** added `_resolve_flag()` to `rules_engine.py`, called from the
`else` branch of every rule check in `check_idle_server()` and
`check_storage()` — a flag is cleared on the same cadence, by the same code
path, as the one that creates it. No separate resolve endpoint was added;
resolution is still purely a byproduct of the next telemetry reading being
evaluated, consistent with everything else in the rule engine being
re-derived from current data rather than mutated out-of-band.

---

## Server types were fixed to match the real dataset's categories

**Decision:** `server_monitor.py`'s server type assignments were corrected
from an earlier version that used `"Memory"` (not a real category) to the
dataset's actual four types: Compute, Edge, GPU, Storage.

**Why this mattered:** The per-type threshold table is keyed by these exact
strings. A simulator emitting a `server_type` the dataset doesn't recognize
silently falls back to the generic `_default` threshold, defeating the whole
point of per-type thresholds.

---

## Storage optimization uses metadata only, never file contents

**Decision:** `storage_monitor.py` and the real-world equivalents it stands
in for (filesystem APIs, storage array tools, cloud storage APIs) only ever
expose size, last-accessed date, and duplication checksums — never file
contents.

**Why this is realistic, not just cautious:** Real production tools (AWS S3
Storage Lens, Azure Storage Metrics) already expose exactly this category of
data by design, because it's operational/infrastructure data, not business
content. This is why storage-optimization access is actually *easier* to
get in a real deployment than people assume — no one needs to read what's
inside a file to flag it as stale or duplicated.

---

## Criticality cannot be inferred from telemetry — a named, unfixed gap

**Decision:** No criticality/SLA/redundancy field exists anywhere in the
current schema. This was discussed explicitly and left as a known gap
rather than faked.

**Why this matters:** A server at 15% CPU could be running a critical
database, a backup service, or an SLA-bound customer workload. CPU/memory/
network telemetry is purely behavioral — it tells you *how hard* a server is
working, never *what* it's doing or *why it matters*. Criticality has to be
**declared** (by a CMDB, SLA record, or orchestration tag), not measured.

**If this gets built later:** it should act as a **gate before** any
consolidation recommendation is even proposed — not as another weighted
factor blended into a score. See `ROADMAP.md`.

---

## The UI was rebuilt from "explanatory text" to "actual visual state" after explicit pushback

**Decision:** An earlier version of the dashboard put numbers in cards with
caption text explaining what each number meant. This was explicitly called
out as inadequate — "just displayed on screen... no representation of
what's going on at all."

**What changed:** `components.jsx` was added with dependency-free visual
primitives — `RingGauge` (circular meter), `CapacityBar` (horizontal bar with
optional threshold tick mark), `Sparkline` (inline trend fill), `StatusDot`.
`Overview.jsx`, `Servers.jsx`, and `ServerDetail.jsx` were rebuilt to use
these instead of plain metric cards.

**Bugs this rebuild introduced and then caught via Playwright screenshot
testing (fixed, but worth knowing about if similar patterns recur):**
1. A `viz-card` missing the `.wide` CSS modifier collapsed into a squished
   single-row flex layout instead of stacking vertically.
2. React effect double-invocation (StrictMode + dev mode) pushed two
   near-identical values into a local sparkline history ref on mount,
   rendering as an ugly flat line. Fixed by deduping consecutive identical
   values before pushing.
3. `RingGauge` always appended `%` to its center value — correct for CPU,
   nonsensical for PUE (showed "72%" for a PUE of 1.44). Fixed by adding an
   optional `displayValue` override prop.
4. `CapacityBar`'s label text used a fixed dark-gray color that was
   unreadable on the dark green recommendation card. Fixed by adding a
   `light` boolean prop that swaps to light-mode text colors.

**Lesson to carry forward:** a clean `npm run build` does not mean the UI
looks right. Screenshot new visual work with a headless browser
(`/opt/pw-browsers/` had a usable Chromium binary in the last environment;
`npx playwright install chromium` may work depending on network access)
before considering it done.

**Still not done:** `Storage.jsx`, `Analytics.jsx`, `ModelEval.jsx` have not
received this same visual treatment — they're still in the earlier
"explanatory text" style. See `ROADMAP.md`.
