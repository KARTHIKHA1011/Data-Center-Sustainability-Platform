import React, { useCallback, useEffect, useState } from "react";

import api from "../api";
import { useAuth } from "../AuthContext";

/*
 * Compliance readiness panel, shown on the ESG report page.
 *
 * For each indicator an external framework asks for, it says whether GreenOps
 * can provide it and how far the value can be trusted (from telemetry,
 * estimated, declared by an operator, or missing). This is alignment with a
 * framework's definitions, not a compliance declaration, and the copy says so.
 */

const STATUS = {
  derived: { label: "From telemetry", cls: "good" },
  estimated: { label: "Estimated", cls: "warn" },
  declared: { label: "Declared", cls: "good" },
  missing: { label: "Missing", cls: "danger" },
};

function formatValue(value, unit) {
  if (value === null || value === undefined) return "—";
  const number = Number(value);
  if (Number.isNaN(number)) return String(value);
  const text = Math.abs(number) >= 1000
    ? number.toLocaleString("en-IN", { maximumFractionDigits: 1 })
    : String(number);
  return unit ? `${text} ${unit}` : text;
}

const blankForm = {
  grid_emission_factor_kg_per_kwh: "",
  emission_factor_source: "",
  installed_it_capacity_kw: "",
  renewable_energy_factor: "",
  energy_reuse_factor: "",
  telemetry_simulated: true,
};

function toForm(settings) {
  const text = (v) => (v === null || v === undefined ? "" : String(v));
  return {
    grid_emission_factor_kg_per_kwh: text(settings.grid_emission_factor_kg_per_kwh),
    emission_factor_source: settings.emission_factor_source || "",
    installed_it_capacity_kw: text(settings.installed_it_capacity_kw),
    renewable_energy_factor: text(settings.renewable_energy_factor),
    energy_reuse_factor: text(settings.energy_reuse_factor),
    telemetry_simulated: !!settings.telemetry_simulated,
  };
}

export default function ComplianceReadiness({ days = 30, onSettingsSaved }) {
  const { user } = useAuth();
  const canEdit = user?.role === "infrastructure_manager";

  const [frameworks, setFrameworks] = useState([]);
  const [frameworkId, setFrameworkId] = useState("eu-2024-1364");
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(blankForm);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  const loadReport = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const response = await api.complianceReport(frameworkId, days);
      setReport(response.data);
    } catch (err) {
      setError("Could not load the compliance readiness report.");
    } finally {
      setLoading(false);
    }
  }, [frameworkId, days]);

  useEffect(() => {
    api.complianceFrameworks()
      .then((response) => setFrameworks(response.data))
      .catch(() => {});
    api.complianceSettings()
      .then((response) => setForm(toForm(response.data)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  const setField = (name, value) => {
    setSaveMessage("");
    setForm((current) => ({ ...current, [name]: value }));
  };

  const numberOrNull = (text) => (text.trim() === "" ? null : Number(text));

  const save = async (event) => {
    event.preventDefault();
    setSaveMessage("");

    const payload = {
      grid_emission_factor_kg_per_kwh: Number(form.grid_emission_factor_kg_per_kwh),
      emission_factor_source: form.emission_factor_source.trim(),
      installed_it_capacity_kw: numberOrNull(form.installed_it_capacity_kw),
      renewable_energy_factor: numberOrNull(form.renewable_energy_factor),
      energy_reuse_factor: numberOrNull(form.energy_reuse_factor),
      telemetry_simulated: form.telemetry_simulated,
    };

    try {
      setSaving(true);
      const response = await api.updateComplianceSettings(payload);
      setForm(toForm(response.data));
      setSaveMessage("Saved. Carbon figures across GreenOps now use this emission factor.");
      await loadReport();
      if (onSettingsSaved) onSettingsSaved();
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setSaveMessage(
        typeof detail === "string"
          ? detail
          : "Could not save. Check the values are in range (fractions between 0 and 1, factor above 0)."
      );
    } finally {
      setSaving(false);
    }
  };

  const readiness = report?.readiness;
  const scope = report?.in_scope;

  return (
    <>
      <div className="section-header" style={{ marginTop: 28 }}>
        <span className="section-title">Compliance readiness</span>
      </div>

      <div className="card cr-card">
        <p className="cr-lead">
          Shows which indicators an external framework asks for, whether GreenOps can
          provide each one, and how far the value can be trusted. This is alignment with
          the framework's definitions, not a compliance declaration.
        </p>

        <div className="cr-tabs" role="tablist">
          {(frameworks.length ? frameworks : [{ id: frameworkId, name: frameworkId }]).map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={f.id === frameworkId}
              className={`cr-tab ${f.id === frameworkId ? "active" : ""}`}
              onClick={() => setFrameworkId(f.id)}
            >
              {f.name}
            </button>
          ))}
        </div>

        {error && <div className="cr-error">{error}</div>}

        {loading && !report && <div className="empty-state">Loading compliance readiness…</div>}

        {report && (
          <>
            <p className="cr-scope">
              <strong>{report.framework.reference}.</strong> {report.framework.scope_note}
            </p>

            <div className="cr-summary">
              {readiness && (
                <span className={`badge ${readiness.missing === 0 ? "good" : "warn"}`}>
                  {readiness.available} of {readiness.total} indicators available
                </span>
              )}
              {readiness &&
                Object.entries(readiness.by_status)
                  .filter(([, count]) => count > 0)
                  .map(([status, count]) => (
                    <span key={status} className={`badge ${STATUS[status]?.cls || "neutral"}`}>
                      {count} {STATUS[status]?.label.toLowerCase() || status}
                    </span>
                  ))}
              {scope && (
                <span
                  className={`badge ${scope.applicable === true ? "warn" : "neutral"}`}
                  title={scope.reason}
                >
                  {scope.applicable === true
                    ? "Within reporting threshold"
                    : scope.applicable === false
                    ? "Below reporting threshold"
                    : "Applicability unknown"}
                </span>
              )}
            </div>
            {scope && <p className="cr-scope-reason">{scope.reason}</p>}

            <div className="cr-table-wrap">
              <table className="data-table cr-table">
                <thead>
                  <tr>
                    <th>Indicator</th>
                    <th>Value</th>
                    <th>Status</th>
                    <th>Definition</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {report.indicators.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.label}</strong>
                        {row.note && <div className="cr-note">{row.note}</div>}
                      </td>
                      <td className="cr-value">{formatValue(row.value, row.unit)}</td>
                      <td>
                        <span className={`badge ${STATUS[row.status]?.cls || "neutral"}`}>
                          {STATUS[row.status]?.label || row.status}
                        </span>
                      </td>
                      <td className="cr-formula">{row.formula}</td>
                      <td className="cr-source">{row.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="info-note">
              <strong>Read this before quoting these values:</strong> {report.alignment_note}
            </div>
          </>
        )}

        <div className="cr-settings-head">
          <button
            type="button"
            className="cr-link"
            onClick={() => setShowSettings((open) => !open)}
            aria-expanded={showSettings}
          >
            {showSettings ? "Hide site settings" : "Site settings and declared inputs"}
          </button>
        </div>

        {showSettings && (
          <form className="cr-form" onSubmit={save}>
            <p className="cr-help">
              The emission factor drives every carbon figure in GreenOps. Capacity, renewable
              factor and reuse factor cannot be derived from telemetry, so they are only
              reported when an operator declares them. Leave a field empty to keep it missing.
              {!canEdit && " Editing requires the Infrastructure Manager role."}
            </p>

            <label className="cr-field">
              <span>Grid emission factor (kg CO₂e per kWh)</span>
              <input
                type="number" step="0.001" min="0.001" max="2" required disabled={!canEdit}
                value={form.grid_emission_factor_kg_per_kwh}
                onChange={(e) => setField("grid_emission_factor_kg_per_kwh", e.target.value)}
              />
            </label>

            <label className="cr-field cr-wide">
              <span>Emission factor source</span>
              <input
                type="text" maxLength={300} required disabled={!canEdit}
                value={form.emission_factor_source}
                onChange={(e) => setField("emission_factor_source", e.target.value)}
              />
            </label>

            <label className="cr-field">
              <span>Installed IT power demand (kW)</span>
              <input
                type="number" step="any" min="0" disabled={!canEdit}
                value={form.installed_it_capacity_kw}
                onChange={(e) => setField("installed_it_capacity_kw", e.target.value)}
              />
            </label>

            <label className="cr-field">
              <span>Renewable energy factor (0 to 1)</span>
              <input
                type="number" step="0.01" min="0" max="1" disabled={!canEdit}
                value={form.renewable_energy_factor}
                onChange={(e) => setField("renewable_energy_factor", e.target.value)}
              />
            </label>

            <label className="cr-field">
              <span>Energy reuse factor (0 to 1)</span>
              <input
                type="number" step="0.01" min="0" max="1" disabled={!canEdit}
                value={form.energy_reuse_factor}
                onChange={(e) => setField("energy_reuse_factor", e.target.value)}
              />
            </label>

            <label className="cr-check">
              <input
                type="checkbox" disabled={!canEdit}
                checked={form.telemetry_simulated}
                onChange={(e) => setField("telemetry_simulated", e.target.checked)}
              />
              <span>Telemetry is simulated (adds a warning to every report)</span>
            </label>

            {canEdit && (
              <div className="cr-actions">
                <button type="submit" className="cr-save" disabled={saving}>
                  {saving ? "Saving…" : "Save settings"}
                </button>
                {saveMessage && <span className="cr-save-message">{saveMessage}</span>}
              </div>
            )}
          </form>
        )}
      </div>

      <style>{`
        .cr-card { padding: 20px 22px; }
        .cr-lead { margin: 0 0 14px; font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
        .cr-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
        .cr-tab {
          padding: 7px 12px; font-size: 12.5px; border-radius: 6px; cursor: pointer;
          border: 1px solid var(--border); background: #fff; color: var(--text-secondary);
        }
        .cr-tab.active { background: var(--accent-dark); color: #fff; border-color: var(--accent-dark); }
        .cr-scope { margin: 0 0 10px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
        .cr-summary { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
        .cr-scope-reason { margin: 0 0 12px; font-size: 12px; color: var(--text-secondary); }
        .cr-table-wrap { overflow-x: auto; margin-bottom: 14px; }
        .cr-table td, .cr-table th { vertical-align: top; }
        .cr-value { white-space: nowrap; font-variant-numeric: tabular-nums; }
        .cr-note { margin-top: 3px; font-size: 11.5px; color: var(--text-secondary); font-weight: 400; line-height: 1.4; }
        .cr-formula { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--text-secondary); }
        .cr-source { font-size: 12px; color: var(--text-secondary); max-width: 220px; }
        .cr-error { padding: 10px 12px; margin-bottom: 12px; border-radius: 6px; font-size: 12.5px; background: var(--danger-bg); color: var(--danger-text); }
        .cr-settings-head { margin-top: 6px; }
        .cr-link { background: none; border: none; padding: 0; cursor: pointer; font-size: 12.5px; color: var(--accent-dark); text-decoration: underline; }
        .cr-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 14px; }
        .cr-help { grid-column: 1 / -1; margin: 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
        .cr-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-secondary); }
        .cr-field.cr-wide { grid-column: 1 / -1; }
        .cr-field input { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; background: #fff; }
        .cr-field input:disabled { background: var(--page-bg); color: var(--text-secondary); }
        .cr-check { grid-column: 1 / -1; display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: var(--text-secondary); }
        .cr-actions { grid-column: 1 / -1; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
        .cr-save-message { font-size: 12.5px; color: var(--text-secondary); }
        .cr-save {
          padding: 9px 16px; font-size: 13px; font-weight: 600; border: none; border-radius: 6px;
          background: var(--accent-dark); color: #fff; cursor: pointer;
        }
        .cr-save:disabled { opacity: 0.6; cursor: default; }
      `}</style>
    </>
  );
}
