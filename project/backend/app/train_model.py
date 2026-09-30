"""
Trains the CPU-estimation and power-estimation resource models using the
REAL "Green AI Data Center Telemetry" dataset (10,000 rows, 15 columns),
loaded from app/data/green_ai_datacenter.csv.

This replaces the earlier synthetic-data version of this script. The
dataset's one real data-quality issue -- 3,990 missing values in
datacenter_region -- is handled explicitly below with a documented
imputation strategy, matching dataset_summary.txt / dataset_metadata.json.

Two separate models are trained here:

  1. CPU estimation model
     target = cpu_utilization
     cpu_utilization is EXCLUDED from its own inputs (target leakage)

  2. Power estimation model
     target = power_consumption_kw
     cpu_utilization IS included as an input here, because CPU is no
     longer the target for this model -- see project notes on why this
     distinction matters.

Run:
    python -m app.train_model
"""
import json
import os

import joblib
import pandas as pd

from sklearn.model_selection import train_test_split
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

try:
    from xgboost import XGBRegressor
    HAS_XGB = True
except ImportError:
    HAS_XGB = False

APP_DIR = os.path.dirname(__file__)
DATA_PATH = os.path.join(APP_DIR, "data", "green_ai_datacenter.csv")
MODEL_DIR = os.path.join(APP_DIR, "ml_artifacts")
os.makedirs(MODEL_DIR, exist_ok=True)

CATEGORICAL_FEATURES = ["server_type", "cooling_type", "datacenter_region", "time_of_day"]

# ---- CPU model feature set (cpu_utilization excluded -- it's the target) ----
CPU_NUMERIC_FEATURES = [
    "workload_intensity", "memory_utilization", "network_throughput_gbps",
    "inlet_temperature_c", "cooling_efficiency", "pue",
]
CPU_TARGET = "cpu_utilization"

# ---- Power model feature set (cpu_utilization included -- CPU is an input now) ----
POWER_NUMERIC_FEATURES = [
    "workload_intensity", "cpu_utilization", "memory_utilization",
    "network_throughput_gbps", "inlet_temperature_c", "cooling_efficiency", "pue",
]
POWER_TARGET = "power_consumption_kw"
POWER_TARGET_RESCALED = "power_consumption_kw_rescaled"

# The Kaggle dataset's power_consumption_kw runs tens-to-hundreds of kW (real
# data center scale). Our live telemetry simulator runs single-digit kW
# (simulators/power_monitor.py: ~1.2-4.5 kW IT power per server). Training
# directly on the dataset's own scale produced predictions 20-40x too large
# to use anywhere near live numbers. Rather than leave the model unusable
# outside a standalone comparison, we linearly rescale the target into the
# live IT-power range below before training -- same real relationships
# (higher CPU/workload -> higher power), just projected onto the range this
# system's own telemetry actually occupies. This does NOT change what the
# model learned, only what units its output is expressed in.
LIVE_IT_POWER_MIN_KW = 1.2
LIVE_IT_POWER_MAX_KW = 4.5


def load_and_clean_dataset():
    if not os.path.exists(DATA_PATH):
        raise FileNotFoundError(
            f"Dataset not found at {DATA_PATH}. Place green_ai_datacenter.csv "
            f"in backend/app/data/ before training."
        )
    df = pd.read_csv(DATA_PATH)

    missing_before = df["datacenter_region"].isna().sum()
    print(f"Loaded {len(df)} rows. Missing datacenter_region values: {missing_before}")

    # Documented imputation strategy: most-frequent category, applied via the
    # sklearn Pipeline's ColumnTransformer below (SimpleImputer) rather than
    # mutating the DataFrame in place, so the exact same imputation is
    # replayed consistently at inference time on live telemetry.
    return df


def rescale_power_target(df):
    """
    Linearly rescale power_consumption_kw from the Kaggle dataset's own
    range down to LIVE_IT_POWER_MIN_KW..LIVE_IT_POWER_MAX_KW, preserving
    relative ordering and shape (min-max scaling), so the model trained on
    it produces output directly comparable to live telemetry.
    """
    kaggle_min = df[POWER_TARGET].min()
    kaggle_max = df[POWER_TARGET].max()
    kaggle_range = kaggle_max - kaggle_min

    live_range = LIVE_IT_POWER_MAX_KW - LIVE_IT_POWER_MIN_KW

    df[POWER_TARGET_RESCALED] = LIVE_IT_POWER_MIN_KW + (
        (df[POWER_TARGET] - kaggle_min) / kaggle_range
    ) * live_range

    return df, {
        "kaggle_min_kw": round(float(kaggle_min), 2),
        "kaggle_max_kw": round(float(kaggle_max), 2),
        "live_min_kw": LIVE_IT_POWER_MIN_KW,
        "live_max_kw": LIVE_IT_POWER_MAX_KW,
    }


def build_pipeline(model, numeric_features):
    preprocessor = ColumnTransformer(transformers=[
        ("num", StandardScaler(), numeric_features),
        ("cat", Pipeline(steps=[
            ("impute", SimpleImputer(strategy="most_frequent")),
            # drop="first" avoids the dummy-variable trap: with every category
            # one-hot'd and an intercept term, the design matrix is exactly
            # collinear, which made LinearRegression's coefficients numerically
            # unstable (near-cancelling terms in the trillions) even though
            # in-distribution test predictions looked fine.
            ("encode", OneHotEncoder(handle_unknown="ignore", drop="first")),
        ]), CATEGORICAL_FEATURES),
    ])
    return Pipeline(steps=[("preprocessor", preprocessor), ("model", model)])


def select_winner(results):
    """
    Selection rule: lowest MAE wins by default, BUT we prefer simpler,
    more explainable models (Linear Regression) unless a more complex
    model (Random Forest, XGBoost) beats it by a meaningful margin.

    Rationale: a 0.5% MAE improvement from XGBoost isn't worth losing
    the interpretability of a linear model in front of a panel. A 5%+
    improvement is a real, defensible reason to pick the more complex
    model instead.
    """
    SIMPLICITY_ORDER = ["LinearRegression", "RandomForest", "XGBoost"]
    MEANINGFUL_MARGIN = 0.05  # 5% relative MAE improvement required to prefer a more complex model

    baseline_name = SIMPLICITY_ORDER[0]
    if baseline_name not in results:
        # fall back to whatever the simplest available candidate is
        baseline_name = next(name for name in SIMPLICITY_ORDER if name in results)
    baseline_mae = results[baseline_name]["MAE"]

    best_name, best_mae = baseline_name, baseline_mae
    for name in SIMPLICITY_ORDER:
        if name not in results or name == baseline_name:
            continue
        candidate_mae = results[name]["MAE"]
        improvement = (baseline_mae - candidate_mae) / baseline_mae
        if improvement > MEANINGFUL_MARGIN and candidate_mae < best_mae:
            best_name, best_mae = name, candidate_mae

    return best_name


def train_target(df, target, numeric_features, label):
    print(f"\n=== Training models for target: {target} ({label}) ===")

    X = df[numeric_features + CATEGORICAL_FEATURES]
    y = df[target]

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    candidates = {
        "LinearRegression": LinearRegression(),
        "RandomForest": RandomForestRegressor(n_estimators=200, random_state=42, n_jobs=-1),
    }
    if HAS_XGB:
        candidates["XGBoost"] = XGBRegressor(
            n_estimators=200, max_depth=5, learning_rate=0.1, random_state=42
        )

    results = {}
    pipelines = {}

    for name, model in candidates.items():
        pipe = build_pipeline(model, numeric_features)
        pipe.fit(X_train, y_train)
        preds = pipe.predict(X_test)

        mae = mean_absolute_error(y_test, preds)
        rmse = mean_squared_error(y_test, preds) ** 0.5
        r2 = r2_score(y_test, preds)

        results[name] = {"MAE": round(mae, 3), "RMSE": round(rmse, 3), "R2": round(r2, 3)}
        pipelines[name] = pipe
        print(f"  {name}: MAE={mae:.3f}  RMSE={rmse:.3f}  R2={r2:.3f}")

    winner = select_winner(results)
    baseline_mae = results["LinearRegression"]["MAE"] if "LinearRegression" in results else None
    if winner != "LinearRegression" and baseline_mae:
        improvement = (baseline_mae - results[winner]["MAE"]) / baseline_mae * 100
        print(f"  -> Selected model: {winner} (beats Linear Regression by {improvement:.1f}% MAE — meaningful margin)")
    else:
        print(f"  -> Selected model: {winner} (simplest model with competitive/best MAE)")

    return winner, pipelines[winner], results


def main():
    df = load_and_clean_dataset()

    # ---- CPU estimation model ----
    cpu_winner, cpu_pipeline, cpu_results = train_target(
        df, CPU_TARGET, CPU_NUMERIC_FEATURES, "validation layer -- not the recommendation engine"
    )
    joblib.dump(cpu_pipeline, os.path.join(MODEL_DIR, "cpu_model.joblib"))

    # ---- Power estimation model ----
    # Trained on a rescaled target so its output lands in the same range as
    # live telemetry (see rescale_power_target() docstring) -- the model
    # still learns from the real Kaggle relationships, just expressed on a
    # different scale, exactly like a unit conversion.
    df, rescale_info = rescale_power_target(df)
    power_winner, power_pipeline, power_results = train_target(
        df, POWER_TARGET_RESCALED, POWER_NUMERIC_FEATURES,
        "used by the Phase 2 what-if engine -- rescaled to live IT-power range"
    )
    joblib.dump(power_pipeline, os.path.join(MODEL_DIR, "power_model.joblib"))

    metrics_out = {
        "dataset_rows": len(df),
        "dataset_columns": len(df.columns),
        "missing_values": {"datacenter_region": int(df["datacenter_region"].isna().sum())},
        "imputation_strategy": "most_frequent category, applied inside the sklearn Pipeline",
        "selection_rule": "Lowest MAE wins, but a more complex model (Random Forest / XGBoost) "
                           "must beat Linear Regression by at least 5% relative MAE improvement "
                           "to be selected over it -- otherwise the simpler, more explainable "
                           "model is kept.",
        "cpu_model": {
            "selected_model": cpu_winner,
            "results": cpu_results,
            "features": {"numeric": CPU_NUMERIC_FEATURES, "categorical": CATEGORICAL_FEATURES},
            "target": CPU_TARGET,
            "note": "cpu_utilization is excluded from its own inputs to avoid target leakage.",
        },
        "power_model": {
            "selected_model": power_winner,
            "results": power_results,
            "features": {"numeric": POWER_NUMERIC_FEATURES, "categorical": CATEGORICAL_FEATURES},
            "target": POWER_TARGET_RESCALED,
            "note": "cpu_utilization IS included here since power, not CPU, is the target. "
                    "MAE/RMSE below are in rescaled kW (live IT-power scale), not the "
                    "dataset's own kW scale -- see rescale below.",
            "rescale": rescale_info,
        },
        "source": "Real 'Green AI Data Center Telemetry' dataset (Kaggle), 10,000 rows, "
                   "as uploaded by the user -- not synthetic.",
    }
    with open(os.path.join(MODEL_DIR, "metrics.json"), "w") as f:
        json.dump(metrics_out, f, indent=2)

    print(f"\nSaved both models + metrics to {MODEL_DIR}")


if __name__ == "__main__":
    main()
