"""Train the GreenOps near-term workload forecast model.

Run after the simulators have accumulated timestamped server telemetry:

    python -m app.train_workload_forecast

This script intentionally trains from the database, not from random or
cross-sectional substitutes. A lagged target needs real temporal sequences.
"""
from datetime import datetime
import json
import os

import joblib
import pandas as pd
from sqlalchemy.orm import Session
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler

try:
    from xgboost import XGBRegressor
except ImportError:
    XGBRegressor = None

from . import forecasting, models
from .database import SessionLocal

MIN_SAMPLES = 30
MODEL_VERSION = "workload-forecast-v1"


def select_winner(results: dict) -> str:
    """Keep the existing GreenOps rule: complexity must earn its place."""
    order = ["LinearRegression", "RandomForest", "XGBoost"]
    baseline = "LinearRegression" if "LinearRegression" in results else next(name for name in order if name in results)
    best = baseline
    baseline_mae = results[baseline]["MAE"]
    for name in order:
        if name not in results or name == baseline:
            continue
        improvement = (baseline_mae - results[name]["MAE"]) / baseline_mae if baseline_mae else 0
        if improvement > 0.05 and results[name]["MAE"] < results[best]["MAE"]:
            best = name
    return best


def candidate_models() -> dict:
    candidates = {
        "LinearRegression": Pipeline([
            ("imputer", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("model", LinearRegression()),
        ]),
        "RandomForest": Pipeline([
            ("imputer", SimpleImputer(strategy="median")),
            ("model", RandomForestRegressor(n_estimators=200, random_state=42, n_jobs=-1)),
        ]),
    }
    if XGBRegressor is not None:
        candidates["XGBoost"] = Pipeline([
            ("imputer", SimpleImputer(strategy="median")),
            ("model", XGBRegressor(
                n_estimators=200,
                max_depth=4,
                learning_rate=0.05,
                objective="reg:squarederror",
                random_state=42,
            )),
        ])
    return candidates


def _train_one_target(frame: pd.DataFrame, target_column: str, target_label: str,
                       model_path: str, metrics_path: str, source_rows: int,
                       horizon_minutes: int = forecasting.FORECAST_HORIZON_MINUTES) -> dict:
    X = frame[forecasting.FEATURE_COLUMNS]
    y = frame[target_column]

    # Chronological holdout: the newest 20% is test data, so the evaluation
    # resembles forecasting the future rather than randomly mixing time.
    split_index = max(1, int(len(frame) * 0.8))
    if split_index >= len(frame):
        split_index = len(frame) - 1
    X_train, X_test = X.iloc[:split_index], X.iloc[split_index:]
    y_train, y_test = y.iloc[:split_index], y.iloc[split_index:]

    results = {}
    fitted = {}
    for name, pipeline in candidate_models().items():
        pipeline.fit(X_train, y_train)
        predictions = pipeline.predict(X_test)
        results[name] = {
            "MAE": round(float(mean_absolute_error(y_test, predictions)), 3),
            "RMSE": round(float(mean_squared_error(y_test, predictions) ** 0.5), 3),
            "R2": round(float(r2_score(y_test, predictions)), 3),
        }
        fitted[name] = pipeline

    winner = select_winner(results)
    os.makedirs(forecasting.MODEL_DIR, exist_ok=True)
    joblib.dump(fitted[winner], model_path)

    metadata = {
        "model_version": MODEL_VERSION,
        "selected_model": winner,
        "selected_metrics": results[winner],
        "all_results": results,
        "feature_columns": forecasting.FEATURE_COLUMNS,
        "target": f"{target_label} at {horizon_minutes} minutes in the future",
        "horizon_minutes": horizon_minutes,
        "source_rows": source_rows,
        "training_samples": len(frame),
        "train_samples": len(X_train),
        "test_samples": len(X_test),
        "training_from": frame["timestamp"].min().isoformat(),
        "training_to": frame["timestamp"].max().isoformat(),
        "trained_at": datetime.utcnow().isoformat(),
        "selection_rule": "A complex model must beat Linear Regression by more than 5% relative MAE to be selected.",
        "limitation": "Forecast continues observed patterns; it cannot anticipate one-off traffic spikes or failures.",
    }
    with open(metrics_path, "w") as file:
        json.dump(metadata, file, indent=2)

    return metadata


def train_from_database(db: Session) -> dict:
    rows = db.query(models.ServerTelemetry).order_by(models.ServerTelemetry.timestamp.asc()).all()
    samples = forecasting.build_feature_rows(rows)
    if len(samples) < MIN_SAMPLES:
        raise RuntimeError(
            f"Only {len(samples)} lagged samples are available. "
            f"Accumulate at least {MIN_SAMPLES} timestamped samples with 15-minute future targets "
            "by running the server simulator, then train again."
        )

    frame = pd.DataFrame(samples).sort_values("timestamp")

    # CPU forecast -- feeds Server Detail's "will this idle server stay idle" check
    # AND recommendations.py's consolidation safety check (forecast_candidate_server()).
    # Horizon stays 15 minutes -- never change this without also checking every
    # caller of forecast_candidate_server(), which relies on this exact horizon.
    cpu_metadata = _train_one_target(
        frame, "target_cpu", "cpu_utilization",
        forecasting.MODEL_PATH, forecasting.METRICS_PATH, len(rows),
        horizon_minutes=forecasting.FORECAST_HORIZON_MINUTES,
    )

    # Memory forecast -- same features and training data, different target.
    # Needed by the consolidation what-if safety check, which has to know
    # about a candidate TARGET's near-term memory headroom too, not just CPU.
    memory_frame = frame.dropna(subset=["target_memory"])
    memory_metadata = None
    if len(memory_frame) >= MIN_SAMPLES:
        memory_metadata = _train_one_target(
            memory_frame, "target_memory", "memory_utilization",
            forecasting.MEMORY_MODEL_PATH, forecasting.MEMORY_METRICS_PATH, len(rows),
            horizon_minutes=forecasting.FORECAST_HORIZON_MINUTES,
        )

    # Separate 1-hour-ahead CPU model for Server Detail's operator-facing
    # "1h" tier -- same lagged-feature architecture, just retargeted further
    # out, and saved under its own filename so it never touches the 15-minute
    # model the safety check depends on. Built from its own sample set since
    # build_feature_rows() shifts the target by horizon_minutes.
    long_samples = forecasting.build_feature_rows(
        rows, horizon_minutes=forecasting.LONG_FORECAST_HORIZON_MINUTES
    )
    long_metadata = None
    if len(long_samples) >= MIN_SAMPLES:
        long_frame = pd.DataFrame(long_samples).sort_values("timestamp")
        long_metadata = _train_one_target(
            long_frame, "target_cpu", "cpu_utilization",
            forecasting.LONG_MODEL_PATH, forecasting.LONG_METRICS_PATH, len(rows),
            horizon_minutes=forecasting.LONG_FORECAST_HORIZON_MINUTES,
        )

    # 1-hour memory model -- reporting parity with the 1-hour CPU model (see
    # forecasting.LONG_MEMORY_MODEL_PATH comment for why this isn't wired
    # into any endpoint yet).
    long_memory_frame_full = pd.DataFrame(long_samples).sort_values("timestamp") if long_samples else pd.DataFrame()
    long_memory_frame = long_memory_frame_full.dropna(subset=["target_memory"]) if len(long_memory_frame_full) else long_memory_frame_full
    long_memory_metadata = None
    if len(long_memory_frame) >= MIN_SAMPLES:
        long_memory_metadata = _train_one_target(
            long_memory_frame, "target_memory", "memory_utilization",
            forecasting.LONG_MEMORY_MODEL_PATH, forecasting.LONG_MEMORY_METRICS_PATH, len(rows),
            horizon_minutes=forecasting.LONG_FORECAST_HORIZON_MINUTES,
        )

    return {
        "cpu_model": cpu_metadata,
        "memory_model": memory_metadata,
        "long_cpu_model": long_metadata,
        "long_memory_model": long_memory_metadata,
    }


def main():
    db = SessionLocal()
    try:
        metadata = train_from_database(db)
        print(json.dumps(metadata, indent=2))
        print(f"Saved {forecasting.MODEL_PATH}")
        print(f"Saved {forecasting.METRICS_PATH}")
        if metadata["memory_model"] is not None:
            print(f"Saved {forecasting.MEMORY_MODEL_PATH}")
            print(f"Saved {forecasting.MEMORY_METRICS_PATH}")
        else:
            print(
                "Memory model skipped -- not enough samples with a valid "
                "future memory reading yet."
            )
        if metadata["long_cpu_model"] is not None:
            print(f"Saved {forecasting.LONG_MODEL_PATH}")
            print(f"Saved {forecasting.LONG_METRICS_PATH}")
        else:
            print(
                "1-hour CPU model skipped -- not enough samples with a valid "
                "60-minute-future reading yet; the 1h tier will use trend "
                "extrapolation until there's enough history."
            )
        if metadata["long_memory_model"] is not None:
            print(f"Saved {forecasting.LONG_MEMORY_MODEL_PATH}")
            print(f"Saved {forecasting.LONG_MEMORY_METRICS_PATH}")
        else:
            print(
                "1-hour memory model skipped -- not enough samples with a "
                "valid 60-minute-future memory reading yet."
            )
    finally:
        db.close()


if __name__ == "__main__":
    main()
