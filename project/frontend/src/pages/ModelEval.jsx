import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, LabelList } from "recharts";
import api from "../api";

const METRIC_META = {
  MAE: { label: "MAE", hint: "avg error — lower is better" },
  RMSE: { label: "RMSE", hint: "penalizes big misses — lower is better" },
  R2: { label: "R²", hint: "variation explained — higher is better" },
};

function MiniBarTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background: "#fff", border: "0.5px solid var(--border)", borderRadius: 8, padding: "6px 10px", fontSize: 12.5, boxShadow: "0 2px 8px rgba(0,0,0,0.08)" }}>
      <strong>{d.name}</strong>: {d.value}
    </div>
  );
}

function MetricChart({ section, metricKey }) {
  const meta = METRIC_META[metricKey];
  const data = Object.entries(section.results).map(([name, m]) => ({ name, value: m[metricKey] }));
  return (
    <div style={{ flex: 1, minWidth: 180 }}>
      <p style={{ fontSize: 12.5, fontWeight: 500, margin: "0 0 2px" }}>{meta.label}</p>
      <p style={{ fontSize: 11.5, color: "var(--text-muted)", margin: "0 0 8px" }}>{meta.hint}</p>
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={data} margin={{ top: 16, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid stroke="#E3ECE8" vertical={false} />
          <XAxis dataKey="name" fontSize={11} stroke="#8A9691" tickLine={false} axisLine={false} tickFormatter={(v) => v.split(" ")[0]} />
          <YAxis hide />
          <Tooltip content={<MiniBarTooltip />} cursor={{ fill: "var(--page-bg)" }} />
          <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={40}>
            {data.map((d) => (
              <Cell key={d.name} fill={d.name === section.selected_model ? "#1D9E75" : "#B4B2A9"} />
            ))}
            <LabelList dataKey="value" position="top" fontSize={11.5} fill="var(--text-secondary)" />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ModelSection({ section }) {
  const isCpu = section.target === "cpu_utilization";
  return (
    <div className="card section-gap">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
        <p className="card-title" style={{ margin: 0 }}>{isCpu ? "CPU estimation model" : "Power estimation model"}</p>
        <span className="badge good">{section.selected_model} selected</span>
      </div>
      <p className="card-subtitle">
        {isCpu
          ? "Predicts CPU% from workload, memory, network, cooling — a check that these signals actually explain resource behaviour."
          : "Predicts power draw (kW) from the same signals plus CPU itself, used later to estimate the effect of moving workloads."}
      </p>
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <MetricChart section={section} metricKey="MAE" />
        <MetricChart section={section} metricKey="RMSE" />
        <MetricChart section={section} metricKey="R2" />
      </div>
      <div className="legend" style={{ marginTop: 4 }}>
        <span className="legend-item"><span className="legend-dot" style={{ background: "#1D9E75" }} /> Selected model</span>
        <span className="legend-item"><span className="legend-dot" style={{ background: "#B4B2A9" }} /> Compared, not chosen</span>
      </div>
      <p className="threshold-note">Target column: <code>{section.target}</code> — {section.note}</p>
    </div>
  );
}

export default function ModelEval() {
  const [metrics, setMetrics] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.modelEvaluation()
      .then((r) => setMetrics(r.data))
      .catch(() => setError("Model not trained yet. Run: python -m app.train_model"));
  }, []);

  return (
    <div>
      <div className="page-header">
        <div className="page-header-top">
          <div>
            <p className="page-title">Model evaluation</p>
            <p className="page-subtitle">
              Three algorithms — Linear Regression, Random Forest, XGBoost — trained on the same
              real data and compared honestly, not just naming a winner.
            </p>
          </div>
        </div>
      </div>

      {error ? (
        <div className="empty-state">{error}</div>
      ) : !metrics ? (
        <div className="empty-state">Loading...</div>
      ) : (
        <>
          <div className="info-banner">
            <span className="info-banner-icon">ⓘ</span>
            <div>
              <strong>How to read MAE / RMSE / R²:</strong> MAE is the average error in percentage
              points — lower is better. RMSE is similar but punishes a few big misses more heavily.
              R² is the share of variation the model explains (0–1) — it is <em>not</em> accuracy,
              so never say "R² of 0.85 = 85% accurate."
            </div>
          </div>

          <div className="metric-grid section-gap">
            <div className="metric-card">
              <p className="metric-label">Dataset rows</p>
              <p className="metric-value">{metrics.dataset_rows}</p>
              <p className="metric-hint">Real historical rows used for training</p>
            </div>
            <div className="metric-card warn">
              <p className="metric-label">Missing region values</p>
              <p className="metric-value">{metrics.missing_values?.datacenter_region}</p>
              <p className="metric-hint">Filled in using most-frequent-category imputation</p>
            </div>
          </div>

          <div className="card section-gap">
            <p className="card-title">How the winning model is chosen</p>
            <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: 0, lineHeight: 1.6 }}>{metrics.selection_rule}</p>
          </div>

          <ModelSection section={metrics.cpu_model} />
          <ModelSection section={metrics.power_model} />
          {metrics.workload_forecast && (
            <div className="card section-gap">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
                <p className="card-title" style={{ margin: 0 }}>Workload forecasting model</p>
                <span className="badge good">{metrics.workload_forecast.selected_model} selected</span>
              </div>
              <p className="card-subtitle">
                A chronological lagged-feature regression that estimates CPU demand {metrics.workload_forecast.horizon_minutes} minutes ahead for servers already flagged as idle or underutilized.
              </p>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                <MetricChart section={{ results: metrics.workload_forecast.all_results, selected_model: metrics.workload_forecast.selected_model }} metricKey="MAE" />
                <MetricChart section={{ results: metrics.workload_forecast.all_results, selected_model: metrics.workload_forecast.selected_model }} metricKey="RMSE" />
                <MetricChart section={{ results: metrics.workload_forecast.all_results, selected_model: metrics.workload_forecast.selected_model }} metricKey="R2" />
              </div>
              <div className="legend" style={{ marginTop: 4 }}>
                <span className="legend-item"><span className="legend-dot" style={{ background: "#1D9E75" }} /> Selected model</span>
                <span className="legend-item"><span className="legend-dot" style={{ background: "#B4B2A9" }} /> Compared, not chosen</span>
              </div>
              <p className="threshold-note">
                Target: <code>cpu_utilization at {metrics.workload_forecast.horizon_minutes} minutes in the future</code> · {metrics.workload_forecast.training_samples} lagged samples · {metrics.workload_forecast.test_samples} chronological holdout samples.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
