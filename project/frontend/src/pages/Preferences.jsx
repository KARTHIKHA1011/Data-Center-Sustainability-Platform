import React, { useEffect, useState } from "react";
import api from "../api";
import { useAuth } from "../AuthContext";

/* ==========================================================================
   1. CONFIGURATION & FIELD METADATA
   ========================================================================== */

const WEIGHT_FIELDS = [
  {
    key: "energy_weight",
    label: "Energy Saved Weight",
    description: "Prioritizes actions that deliver high raw kWh power savings.",
    color: "#1D9E75",
  },
  {
    key: "cost_weight",
    label: "Cost Savings Weight",
    description: "Scales candidate rank based on estimated monetary savings.",
    color: "#0F6E56",
  },
  {
    key: "carbon_weight",
    label: "Carbon Reduction Weight",
    description: "Emphasizes environmental impact and greenhouse gas reduction.",
    color: "#2F9C95",
  },
  {
    key: "water_weight",
    label: "Water Conservation Weight",
    description: "Weights actions according to projected cooling water savings.",
    color: "#1D6F9E",
  },
  {
    key: "risk_weight",
    label: "Risk Penalty Weight",
    description: "Subtracts from overall score based on target server load post-move.",
    color: "#C2413B",
  },
];

// Must match models.Preferences' column defaults exactly -- "Reset Defaults"
// should reset to what the system actually defaults to, not a different,
// merely-plausible-looking set of numbers.
const DEFAULT_WEIGHTS = {
  energy_weight: 1.0,
  cost_weight: 1.0,
  carbon_weight: 1.0,
  water_weight: 0.5,
  risk_weight: 1.0,
};

/* ==========================================================================
   2. SUB-COMPONENTS
   ========================================================================== */

function WeightSliderCard({ field, value, onChange, canEdit }) {
  return (
    <div className="weight-card">
      <div className="weight-card-header">
        <div>
          <label htmlFor={field.key} className="weight-label">
            {field.label}
          </label>
          <p className="weight-description">{field.description}</p>
        </div>
        <span className="weight-value-badge" style={{ borderColor: field.color }}>
          {value !== undefined && value !== null ? value.toFixed(1) : "1.0"}
        </span>
      </div>

      <div className="slider-container">
        <input
          id={field.key}
          type="range"
          min="0"
          max="5"
          step="0.1"
          value={value ?? 1.0}
          onChange={(e) => canEdit && onChange(field.key, e.target.value)}
          className="weight-slider"
          style={{
            accentColor: field.color,
            opacity: canEdit ? 1 : 0.5,
            cursor: canEdit ? "pointer" : "not-allowed",
          }}
          disabled={!canEdit}
        />
        <div className="slider-ticks">
          <span>0.0 (Ignore)</span>
          <span>2.5 (Medium)</span>
          <span>5.0 (Critical)</span>
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   3. MAIN PAGE CONTAINER & SCOPED INLINE STYLES
   ========================================================================== */

export default function Preferences() {
  const [weights, setWeights] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const { user } = useAuth();
  const canEdit = user?.role === "infrastructure_manager";

  useEffect(() => {
    let active = true;
    api
      .preferences()
      .then((res) => {
        if (active) {
          setWeights(res.data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setError("Failed to load scoring weights from server.");
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const handleChange = (key, value) => {
    setWeights((prev) => ({ ...prev, [key]: Number(value) }));
    setSaved(false);
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError("");
      await api.updatePreferences(weights);
      setSaved(true);
    } catch {
      setError("Failed to save scoring preferences.");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setWeights({ ...DEFAULT_WEIGHTS });
    setSaved(false);
  };

  return (
    <>
      <style>{`
        .preferences-container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 8px 0 32px 0;
        }

        .preferences-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
          margin-bottom: 20px;
        }

        .weights-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
          gap: 16px;
          margin-bottom: 24px;
        }

        .weight-card {
          background: var(--card-bg, #FFFFFF);
          border: 0.5px solid var(--border, #E3ECE8);
          border-radius: 12px;
          padding: 18px 20px;
          box-shadow: 0 1px 2px rgba(4, 52, 44, 0.04);
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }

        .weight-card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          margin-bottom: 16px;
        }

        .weight-label {
          font-size: 15px;
          font-weight: 600;
          color: var(--text-primary, #1C2622);
          display: block;
          margin-bottom: 4px;
        }

        .weight-description {
          font-size: 12.5px;
          color: var(--text-secondary, #5F6E68);
          margin: 0;
          line-height: 1.45;
        }

        .weight-value-badge {
          font-size: 16px;
          font-weight: 700;
          color: var(--text-primary, #1C2622);
          background: var(--page-bg, #F2F8F5);
          border: 2px solid var(--accent, #1D9E75);
          padding: 4px 10px;
          border-radius: 8px;
          min-width: 44px;
          text-align: center;
          flex-shrink: 0;
        }

        .slider-container {
          width: 100%;
        }

        .weight-slider {
          width: 100%;
          height: 6px;
          background: rgba(0, 0, 0, 0.08);
          border-radius: 3px;
          outline: none;
          cursor: pointer;
        }

        .slider-ticks {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          color: var(--text-muted, #8A9691);
          margin-top: 6px;
        }

        .actions-card {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
          padding: 16px 20px;
          background: var(--card-bg, #FFFFFF);
          border: 0.5px solid var(--border, #E3ECE8);
          border-radius: 12px;
          box-shadow: 0 1px 2px rgba(4, 52, 44, 0.04);
        }

        .action-buttons-group {
          display: flex;
          gap: 10px;
          align-items: center;
        }

        /* Standardized Button Tokens */
        .btn-primary,
        .btn-secondary {
          padding: 9px 16px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease-in-out;
          outline: none;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          line-height: 1.2;
        }

        .btn-primary {
          background-color: var(--accent-dark, #0F6E56);
          color: #FFFFFF;
          border: 1px solid var(--accent-dark, #0F6E56);
          box-shadow: 0 1px 2px rgba(4, 52, 44, 0.08);
        }

        .btn-primary:hover:not(:disabled) {
          background-color: var(--sidebar-bg, #04342C);
          border-color: var(--sidebar-bg, #04342C);
        }

        .btn-primary:active:not(:disabled) {
          transform: translateY(1px);
        }

        .btn-secondary {
          background-color: #FFFFFF;
          color: var(--text-primary, #1C2622);
          border: 1px solid var(--border, #E3ECE8);
          box-shadow: 0 1px 2px rgba(4, 52, 44, 0.02);
        }

        .btn-secondary:hover:not(:disabled) {
          background-color: var(--page-bg, #F2F8F5);
          border-color: #BCD8CC;
          color: var(--accent-dark, #0F6E56);
        }

        .btn-secondary:active:not(:disabled) {
          transform: translateY(1px);
        }

        .btn-primary:disabled,
        .btn-secondary:disabled {
          opacity: 0.55;
          cursor: not-allowed;
          transform: none;
        }

        .status-message {
          font-size: 13px;
          color: var(--success-text, #0F6E56);
          font-weight: 500;
        }

        .info-note {
          font-size: 13px;
          color: var(--text-secondary, #5F6E68);
          background: #F4F8F6;
          border: 1px solid #DCEFE7;
          border-radius: 8px;
          padding: 12px 14px;
          margin-top: 20px;
          line-height: 1.5;
        }

        @media (max-width: 768px) {
          .preferences-header,
          .actions-card {
            flex-direction: column;
            align-items: flex-start;
          }

          .actions-card {
            gap: 16px;
          }

          .action-buttons-group {
            width: 100%;
            justify-content: flex-end;
          }
        }
      `}</style>

      <div className="preferences-container">
        <div className="preferences-header">
          <div>
            <h1 className="page-title">Recommendation Weights</h1>
            <p className="page-subtitle">
              Configure parameters to customize how recommendation actions are scored, prioritized, and ranked.
            </p>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {loading ? (
          <div className="empty-state">Loading preferences...</div>
        ) : (
          <>
            <div className="section-block">
              <p className="section-label">Ranking Coefficients</p>
              {!canEdit && (
                <div style={{
                  fontSize: 13, color: "var(--text-secondary)",
                  background: "#F4F8F6", border: "1px solid #DCEFE7",
                  borderRadius: 8, padding: "10px 14px", marginBottom: 16,
                }}>
                  View only — modifying recommendation weights requires the Infrastructure Manager role.
                </div>
              )}
              <div className="weights-grid">
                {WEIGHT_FIELDS.map((field) => (
                  <WeightSliderCard
                    key={field.key}
                    field={field}
                    value={weights[field.key]}
                    onChange={handleChange}
                    canEdit={canEdit}
                  />
                ))}
              </div>
            </div>

            {canEdit && (
            <div className="actions-card">
              <div>
                {saved ? (
                  <span className="status-message">
                    ✓ Preferences updated successfully.
                  </span>
                ) : (
                  <span className="card-subtitle" style={{ margin: 0 }}>
                    Changes re-score candidate actions immediately without retraining models.
                  </span>
                )}
              </div>

              <div className="action-buttons-group">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleReset}
                  disabled={saving}
                >
                  Reset Defaults
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save Preferences"}
                </button>
              </div>
            </div>
            )}
          </>
        )}
      </div>
    </>
  );
}