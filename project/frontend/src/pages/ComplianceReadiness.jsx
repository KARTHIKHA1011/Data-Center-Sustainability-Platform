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
  derived: {
    label: "From telemetry",
    cls: "good",
    meaning: "Calculated directly from the power and server readings.",
  },
  estimated: {
    label: "Estimated",
    cls: "warn",
    meaning: "Modelled with a reference factor, not measured by a meter.",
  },
  declared: {
    label: "Declared",
    cls: "good",
    meaning: "Entered by an operator in site settings, never guessed.",
  },
  missing: {
    label: "Missing",
    cls: "danger",
    meaning: "GreenOps has no way to know this, so it says so.",
  },
};

const STATUS_ORDER = ["derived", "estimated", "declared", "missing"];

function formatValue(value, unit) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (Number.isNaN(number)) return { text: String(value), unit };
  const text = Math.abs(number) >= 1000
    ? number.toLocaleString("en-IN", { maximumFractionDigits: 1 })
    : String(number);
  return { text, unit };
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
  const scopeTone =
    scope?.applicable === true ? "warn" : scope?.applicable === false ? "good" : "neutral";
  const scopeHeadline =
    scope?.applicable === true
      ? "Within the reporting threshold"
      : scope?.applicable === false
      ? "Below the reporting threshold"
      : "Applicability unknown";

  return (
    <>
      <div className="section-header" style={{ marginTop: 28 }}>
        <span className="section-title">Compliance readiness</span>
      </div>

      <div className="card cr-card">
        <p className="cr-lead">
          Each framework asks for specific indicators. This panel shows whether GreenOps can
          provide each one and how far the value can be trusted. It checks alignment with the
          framework's definitions and is not a compliance declaration.
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
              <span className="cr-tab-name">{f.name}</span>
              {f.jurisdiction && (
                <span className="cr-tab-meta">
                  {f.jurisdiction}
                  {f.indicator_count ? ` · ${f.indicator_count} indicators` : ""}
                </span>
              )}
            </button>
          ))}
        </div>

        {error && <div className="cr-error">{error}</div>}

        {loading && !report && <div className="empty-state">Loading compliance readiness…</div>}

        {report && (
          <>
            <div className="cr-framework">
              <div className="cr-framework-ref">{report.framework.reference}</div>
              <div className="cr-framework-scope">{report.framework.scope_note}</div>
            </div>

            {scope && (
              <div className={`cr-callout cr-callout-${scopeTone}`}>
                <div className="cr-callout-title">{scopeHeadline}</div>
                <div className="cr-callout-body">{scope.reason}</div>
              </div>
            )}

            {readiness && (
              <div className="cr-stats">
                <div className="cr-stat cr-stat-lead">
                  <div className="cr-stat-number">
                    {readiness.available}
                    <span className="cr-stat-of"> of {readiness.total}</span>
                  </div>
                  <div className="cr-stat-label">indicators available</div>
                  <div className="cr-stat-hint">
                    How much of this framework GreenOps can provide. It does not say whether a site complies.
                  </div>
                </div>
                {STATUS_ORDER.map((status) => (
                  <div key={status} className={`cr-stat cr-stat-${STATUS[status].cls}`}>
                    <div className="cr-stat-number">{readiness.by_status[status] ?? 0}</div>
                    <div className="cr-stat-label">{STATUS[status].label}</div>
                    <div className="cr-stat-hint">{STATUS[status].meaning}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="cr-grid">
              {report.indicators.map((row) => {
                const value = formatValue(row.value, row.unit);
                const status = STATUS[row.status] || { label: row.status, cls: "neutral" };
                return (
                  <div key={row.id} className={`cr-indicator cr-indicator-${row.status}`}>
                    <div className="cr-indicator-head">
                      <span className="cr-indicator-label">{row.label}</span>
                      <span className={`badge ${status.cls}`}>{status.label}</span>
                    </div>

                    <div className="cr-indicator-value">
                      {value ? (
                        <>
                          <span className="cr-value-number">{value.text}</span>
                          {value.unit && <span className="cr-value-unit">{value.unit}</span>}
                        </>
                      ) : (
                        <span className="cr-value-none">Not available</span>
                      )}
                    </div>

                    <dl className="cr-indicator-meta">
                      <div>
                        <dt>How it is calculated</dt>
                        <dd className="cr-formula">{row.formula}</dd>
                      </div>
                      <div>
                        <dt>Source</dt>
                        <dd>{row.source}</dd>
                      </div>
                    </dl>

                    {row.note && <div className="cr-note">{row.note}</div>}
                  </div>
                );
              })}
            </div>

            <div className="cr-callout cr-callout-warn cr-caveat">
              <div className="cr-callout-title">Read this before quoting these values</div>
              <div className="cr-callout-body">{report.alignment_note}</div>
            </div>
          </>
        )}

        <div className="cr-settings">
          <button
            type="button"
            className="cr-settings-toggle"
            onClick={() => setShowSettings((open) => !open)}
            aria-expanded={showSettings}
          >
            <span>Site settings and declared inputs</span>
            <span className="cr-chevron" aria-hidden="true">{showSettings ? "−" : "+"}</span>
          </button>

          {showSettings && (
            <form className="cr-form" onSubmit={save}>
              <p className="cr-help">
                {canEdit
                  ? "Only the Infrastructure Manager can change these."
                  : "Read only. Editing needs the Infrastructure Manager role."}
              </p>

              <fieldset className="cr-fieldset">
                <legend>Carbon</legend>
                <p className="cr-fieldset-hint">
                  This emission factor drives every carbon figure in GreenOps.
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
              </fieldset>

              <fieldset className="cr-fieldset">
                <legend>Declared inputs</legend>
                <p className="cr-fieldset-hint">
                  Telemetry cannot tell GreenOps these, so they are reported only when declared.
                  Leave a field empty to keep that indicator marked as missing.
                </p>
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
              </fieldset>

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
      </div>

      <style>{`
        .cr-card { padding: 22px 24px; }
        .cr-lead { margin: 0 0 16px; font-size: 13px; color: var(--text-secondary); line-height: 1.55; max-width: 760px; }

        .cr-tabs { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
        .cr-tab {
          display: flex; flex-direction: column; gap: 3px; text-align: left;
          padding: 10px 14px; border-radius: 10px; cursor: pointer; max-width: 360px;
          border: 1px solid var(--border); background: #fff; color: var(--text-secondary);
          transition: border-color .15s, background .15s;
        }
        .cr-tab:hover { border-color: var(--accent); }
        .cr-tab-name { font-size: 13px; font-weight: 600; color: var(--text-primary); line-height: 1.35; }
        .cr-tab-meta { font-size: 11.5px; color: var(--text-muted); }
        .cr-tab.active { background: var(--accent-dark); border-color: var(--accent-dark); }
        .cr-tab.active .cr-tab-name { color: #fff; }
        .cr-tab.active .cr-tab-meta { color: rgba(255,255,255,.75); }

        .cr-framework { margin-bottom: 12px; }
        .cr-framework-ref { font-size: 12px; font-weight: 700; color: var(--accent-dark); letter-spacing: .02em; }
        .cr-framework-scope { margin-top: 3px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }

        .cr-callout { border-radius: 10px; padding: 12px 14px; margin-bottom: 16px; border-left: 4px solid var(--border); background: var(--page-bg); }
        .cr-callout-title { font-size: 12.5px; font-weight: 700; color: var(--text-primary); margin-bottom: 2px; }
        .cr-callout-body { font-size: 12.5px; color: var(--text-secondary); line-height: 1.55; }
        .cr-callout-good { background: var(--success-bg); border-left-color: var(--accent); }
        .cr-callout-warn { background: var(--warn-bg); border-left-color: #D9962B; }
        .cr-callout-warn .cr-callout-title { color: var(--warn-text); }
        .cr-caveat { margin: 18px 0 0; }

        .cr-stats { display: grid; grid-template-columns: 1.4fr repeat(4, 1fr); gap: 12px; margin-bottom: 18px; }
        .cr-stat { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: #fff; }
        .cr-stat-lead { background: var(--accent-darker); border-color: var(--accent-darker); }
        .cr-stat-lead .cr-stat-number, .cr-stat-lead .cr-stat-label { color: #fff; }
        .cr-stat-lead .cr-stat-hint { color: rgba(255,255,255,.72); }
        .cr-stat-of { font-size: 14px; font-weight: 500; opacity: .75; }
        .cr-stat-number { font-size: 24px; font-weight: 700; color: var(--text-primary); line-height: 1.1; font-variant-numeric: tabular-nums; }
        .cr-stat-label { margin-top: 3px; font-size: 12px; font-weight: 700; color: var(--text-primary); }
        .cr-stat-hint { margin-top: 4px; font-size: 11.5px; color: var(--text-muted); line-height: 1.4; }
        .cr-stat-good .cr-stat-number { color: var(--success-text); }
        .cr-stat-warn .cr-stat-number { color: var(--warn-text); }
        .cr-stat-danger .cr-stat-number { color: var(--danger-text); }

        .cr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }
        .cr-indicator {
          display: flex; flex-direction: column; gap: 10px;
          border: 1px solid var(--border); border-left: 4px solid var(--border);
          border-radius: 10px; padding: 14px 16px; background: #fff;
        }
        .cr-indicator-derived, .cr-indicator-declared { border-left-color: var(--accent); }
        .cr-indicator-estimated { border-left-color: #D9962B; }
        .cr-indicator-missing { border-left-color: #D98A70; background: #FFFCFB; }
        .cr-indicator-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
        .cr-indicator-label { font-size: 13px; font-weight: 700; color: var(--text-primary); line-height: 1.35; }
        .cr-indicator-value { display: flex; align-items: baseline; gap: 6px; min-height: 34px; }
        .cr-value-number { font-size: 26px; font-weight: 700; color: var(--accent-darker); font-variant-numeric: tabular-nums; }
        .cr-value-unit { font-size: 12.5px; color: var(--text-secondary); }
        .cr-value-none { font-size: 14px; font-weight: 600; color: var(--text-muted); }
        .cr-indicator-meta { margin: 0; display: flex; flex-direction: column; gap: 8px; }
        .cr-indicator-meta dt { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--text-muted); margin-bottom: 2px; }
        .cr-indicator-meta dd { margin: 0; font-size: 12px; color: var(--text-secondary); line-height: 1.45; }
        .cr-formula {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px !important;
          background: var(--page-bg); border-radius: 6px; padding: 5px 8px; display: inline-block;
        }
        .cr-note { font-size: 11.5px; color: var(--text-secondary); line-height: 1.5; padding-top: 8px; border-top: 1px dashed var(--border); }

        .cr-error { padding: 10px 12px; margin-bottom: 12px; border-radius: 6px; font-size: 12.5px; background: var(--danger-bg); color: var(--danger-text); }

        .cr-settings { margin-top: 22px; border-top: 1px solid var(--border); padding-top: 14px; }
        .cr-settings-toggle {
          width: 100%; display: flex; justify-content: space-between; align-items: center;
          background: none; border: none; padding: 4px 0; cursor: pointer;
          font-size: 13px; font-weight: 600; color: var(--accent-dark);
        }
        .cr-chevron { font-size: 18px; line-height: 1; }
        .cr-form { display: flex; flex-direction: column; gap: 16px; margin-top: 12px; }
        .cr-help { margin: 0; font-size: 12px; color: var(--text-secondary); }
        .cr-fieldset {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px;
          border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin: 0;
        }
        .cr-fieldset legend { padding: 0 6px; font-size: 12px; font-weight: 700; color: var(--text-primary); }
        .cr-fieldset-hint { grid-column: 1 / -1; margin: 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
        .cr-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-secondary); }
        .cr-field.cr-wide { grid-column: 1 / -1; }
        .cr-field input { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; background: #fff; }
        .cr-field input:disabled { background: var(--page-bg); color: var(--text-secondary); }
        .cr-check { display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: var(--text-secondary); }
        .cr-actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
        .cr-save-message { font-size: 12.5px; color: var(--text-secondary); }
        .cr-save {
          padding: 9px 16px; font-size: 13px; font-weight: 600; border: none; border-radius: 6px;
          background: var(--accent-dark); color: #fff; cursor: pointer;
        }
        .cr-save:disabled { opacity: 0.6; cursor: default; }

        @media (max-width: 1100px) {
          .cr-stats { grid-template-columns: repeat(2, 1fr); }
          .cr-stat-lead { grid-column: 1 / -1; }
        }
      `}</style>
    </>
  );
}
