"""
Experiment: how should missing datacenter_region values be handled?

Compares four treatments on the same data, same models and same splits:

  A   most-frequent imputation (the current pipeline)
  A+  most-frequent imputation plus a "region was missing" indicator
  B   missing values become a separate "Unknown" category
  C   datacenter_region removed entirely

Each is evaluated for the CPU and power estimation targets with Linear
Regression, Random Forest and XGBoost (hyperparameters copied from
train_model.py), twice:

  1. the production 80/20 split (random_state=42), so numbers line up with
     the paper's tables
  2. repeated 5-fold cross-validation (3 repeats), mean +/- std, because a
     single split cannot separate a real difference from noise

This script never touches the trained artifacts. Run from backend/:

    python -m app.experiments.region_imputation
"""
import json
import os
import time

import numpy as np
import pandas as pd
from scipy import stats
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import RepeatedKFold, cross_validate, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from app import train_model as tm

try:
    from xgboost import XGBRegressor
except ImportError:  # pragma: no cover
    XGBRegressor = None

OUT_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "docs", "experiments"))
os.makedirs(OUT_DIR, exist_ok=True)

REGION = "datacenter_region"
CONFIGS = ["A", "A+", "B", "C"]
CONFIG_LABEL = {
    "A": "A: most frequent",
    "A+": "A+: most frequent + missing flag",
    "B": "B: Unknown category",
    "C": "C: drop region",
}
TARGETS = {
    "CPU": (tm.CPU_TARGET, tm.CPU_NUMERIC_FEATURES),
    "Power": (tm.POWER_TARGET_RESCALED, tm.POWER_NUMERIC_FEATURES),
}


def make_model(name):
    if name == "LinearRegression":
        return LinearRegression()
    if name == "RandomForest":
        return RandomForestRegressor(n_estimators=200, random_state=42, n_jobs=-1)
    if name == "XGBoost":
        return XGBRegressor(n_estimators=200, max_depth=5, learning_rate=0.1, random_state=42)
    raise ValueError(name)


MODELS = ["LinearRegression", "RandomForest"] + (["XGBoost"] if XGBRegressor else [])


# The categorical list as it was BEFORE region was dropped from production,
# kept here so this experiment stays reproducible.
ALL_CATEGORICAL = ["server_type", "cooling_type", "datacenter_region", "time_of_day"]


def feature_sets(config, numeric):
    cats = [c for c in ALL_CATEGORICAL if not (config == "C" and c == REGION)]
    nums = list(numeric) + (["region_missing"] if config == "A+" else [])
    return nums, cats


def build_pipeline(config, numeric, model_name):
    nums, cats = feature_sets(config, numeric)
    if config == "B":
        # Only region has gaps, so a constant fill leaves the other columns untouched.
        cat_imputer = SimpleImputer(strategy="constant", fill_value="Unknown")
    else:
        cat_imputer = SimpleImputer(strategy="most_frequent")
    pre = ColumnTransformer([
        ("num", StandardScaler(), nums),
        ("cat", Pipeline([
            ("impute", cat_imputer),
            ("encode", OneHotEncoder(handle_unknown="ignore", drop="first")),
        ]), cats),
    ])
    return Pipeline([("pre", pre), ("model", make_model(model_name))])


def columns_for(config, numeric):
    nums, cats = feature_sets(config, numeric)
    return nums + cats


def load():
    df = tm.load_and_clean_dataset()
    df, _ = tm.rescale_power_target(df)
    df["region_missing"] = df[REGION].isna().astype(float)
    return df


def data_checks(df):
    out = {}
    missing = df[REGION].isna()
    out["rows"] = int(len(df))
    out["missing_region"] = int(missing.sum())
    out["missing_pct"] = round(float(missing.mean() * 100), 2)
    out["region_distribution_non_missing"] = {k: int(v) for k, v in df[REGION].value_counts().items()}

    group = {}
    for target in ["cpu_utilization", "power_consumption_kw"]:
        a, b = df.loc[missing, target], df.loc[~missing, target]
        u = stats.mannwhitneyu(a, b)
        group[target] = {
            "mean_missing": round(float(a.mean()), 3),
            "mean_present": round(float(b.mean()), 3),
            "mannwhitney_p": float(u.pvalue),
        }
    out["target_missing_vs_present"] = group

    assoc = {}
    for col in ["server_type", "cooling_type", "time_of_day"]:
        table = pd.crosstab(df[col], missing)
        chi2, p, _, _ = stats.chi2_contingency(table)
        assoc[col] = {"chi2_p": float(p)}
    out["missingness_vs_other_categoricals"] = assoc

    known = df[~missing]
    by_region = {}
    for target in ["cpu_utilization", "power_consumption_kw"]:
        groups = [g[target].values for _, g in known.groupby(REGION)]
        by_region[target] = {
            "means": {str(r): round(float(g[target].mean()), 3) for r, g in known.groupby(REGION)},
            "kruskal_p": float(stats.kruskal(*groups).pvalue),
        }
    out["target_by_region_non_missing"] = by_region
    return out


def split_eval(df):
    rows = []
    for tname, (target, numeric) in TARGETS.items():
        for config in CONFIGS:
            cols = columns_for(config, numeric)
            X, y = df[cols], df[target]
            X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, random_state=42)
            for mname in MODELS:
                pipe = build_pipeline(config, numeric, mname).fit(X_tr, y_tr)
                pred = pipe.predict(X_te)
                rows.append({
                    "target": tname, "config": config, "model": mname,
                    "MAE": mean_absolute_error(y_te, pred),
                    "RMSE": mean_squared_error(y_te, pred) ** 0.5,
                    "R2": r2_score(y_te, pred),
                })
    return rows


def cv_eval(df):
    cv = RepeatedKFold(n_splits=5, n_repeats=3, random_state=42)
    rows, fold_mae = [], {}
    for tname, (target, numeric) in TARGETS.items():
        for config in CONFIGS:
            cols = columns_for(config, numeric)
            X, y = df[cols], df[target]
            for mname in MODELS:
                res = cross_validate(
                    build_pipeline(config, numeric, mname), X, y, cv=cv,
                    scoring={"mae": "neg_mean_absolute_error", "rmse": "neg_root_mean_squared_error", "r2": "r2"},
                )
                mae, rmse, r2 = -res["test_mae"], -res["test_rmse"], res["test_r2"]
                fold_mae[(tname, config, mname)] = mae
                rows.append({
                    "target": tname, "config": config, "model": mname,
                    "MAE_mean": mae.mean(), "MAE_std": mae.std(),
                    "RMSE_mean": rmse.mean(), "RMSE_std": rmse.std(),
                    "R2_mean": r2.mean(), "R2_std": r2.std(),
                })
                print(f"  cv {tname:5s} {config:2s} {mname:16s} MAE {mae.mean():.4f} +/- {mae.std():.4f}", flush=True)
    # Paired differences against A on identical folds.
    paired = []
    for tname in TARGETS:
        for mname in MODELS:
            base = fold_mae[(tname, "A", mname)]
            for config in CONFIGS[1:]:
                diff = fold_mae[(tname, config, mname)] - base
                paired.append({
                    "target": tname, "model": mname, "config": config,
                    "MAE_diff_vs_A_mean": diff.mean(), "MAE_diff_vs_A_std": diff.std(),
                    "relative_pct": float(diff.mean() / base.mean() * 100),
                    "folds_better_than_A": int((diff < 0).sum()), "folds": int(len(diff)),
                })
    return rows, paired


def main():
    t0 = time.time()
    df = load()
    print("== data checks ==")
    checks = data_checks(df)
    print(json.dumps(checks, indent=2))

    print("\n== 80/20 split (random_state=42) ==")
    split_rows = split_eval(df)
    print(pd.DataFrame(split_rows).round(4).to_string(index=False))

    print("\n== repeated 5-fold CV x3 ==")
    cv_rows, paired = cv_eval(df)

    result = {
        "data_checks": checks,
        "split_80_20": split_rows,
        "cv_5fold_x3": cv_rows,
        "paired_vs_A": paired,
        "runtime_seconds": round(time.time() - t0, 1),
    }
    with open(os.path.join(OUT_DIR, "region_imputation_results.json"), "w") as f:
        json.dump(result, f, indent=2)
    pd.DataFrame(split_rows).to_csv(os.path.join(OUT_DIR, "region_imputation_split.csv"), index=False)
    pd.DataFrame(cv_rows).to_csv(os.path.join(OUT_DIR, "region_imputation_cv.csv"), index=False)
    pd.DataFrame(paired).to_csv(os.path.join(OUT_DIR, "region_imputation_paired.csv"), index=False)

    print("\n== paired MAE difference vs A (negative = better than A) ==")
    print(pd.DataFrame(paired).round(4).to_string(index=False))
    print(f"\nSaved to {OUT_DIR}  ({result['runtime_seconds']}s)")


if __name__ == "__main__":
    main()
