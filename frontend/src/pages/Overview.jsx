import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../api";

/* ==========================================================================
   1. UTILITY FUNCTIONS & FORMATTERS
   ========================================================================== */

function pueTone(pue) {
  if (pue <= 1.3) return { class: "good", label: "Optimal Efficiency" };
  if (pue <= 1.6) return { class: "warn", label: "Moderate Overhead" };
  return { class: "danger", label: "High Overhead" };
}

function formatRecordedMetric(flagType, value, threshold) {
  if (value === null || value === undefined) return "—";
  if (flagType === "idle_server") {
    const deficit = threshold ? (threshold - value).toFixed(1) : null;
    return {
      main: `${value}% CPU (6h Rolling Avg)`,
      sub: deficit ? `${deficit}% below ${threshold}% idle cutoff baseline` : "Below idle cutoff baseline",
    };
  }
  if (flagType === "overprovisioned") {
    return { main: `${value}% Capacity Used`, sub: "Below 30% utilization threshold" };
  }
  if (flagType === "duplicate_data") {
    return { main: `${value} GB Duplicated`, sub: "Exceeds 20% duplicate data threshold" };
  }
  if (flagType === "stale_data") {
    return { main: `${value} Days Unaccessed`, sub: "Exceeds 90-day staleness threshold" };
  }
  return { main: `${value}`, sub: "Rule constraint triggered" };
}

/* ==========================================================================
   2. MAIN PAGE COMPONENT
   ========================================================================== */

export default function Overview() {
  const [summary, setSummary] = useState(null);
  const [servers, setServers] = useState([]);
  const [flags, setFlags] = useState([]);
  const [thresholds, setThresholds] = useState({});
  const [apiOk, setApiOk] = useState(false);
  const [error, setError] = useState(null);
  const [windowHours, setWindowHours] = useState(6);

  useEffect(() => {
    const load = async () => {
      try {
        await api.root();
        setApiOk(true);
      } catch {
        setApiOk(false);
      }
      try {
        const [s, sv, f, th] = await Promise.all([
          api.analyticsSummary(windowHours),
          api.servers(),
          api.allFlags(),
          api.thresholds(),
        ]);
        setSummary(s.data);
        setServers(sv.data || []);
        setFlags(f.data || []);
        setThresholds(th.data || {});
        setError(null);
      } catch (e) {
        setError("Unable to connect to backend telemetry streams.");
      }
    };
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [windowHours]);

  // Highest priority flag sorting (High -> Medium -> Low)
  const topFlag = [...flags].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
  })[0];

  // Action-required server filtering -- specifically "Underutilized", not
  // just "not Healthy". A server whose telemetry has simply gone stale
  // (avg_cpu is null because nothing's arrived in the last 6h) isn't the
  // same finding as one confirmed underutilized right now; lumping them
  // together mislabeled stale servers as "Underutilized" in this count.
  const flaggedServers = servers.filter((s) => {
    const t = thresholds[s.server_type];
    const underThreshold = t && s.avg_cpu != null && s.avg_cpu < t.idle_cpu_threshold;
    const isUnderutilizedState = s.state && s.state.toLowerCase() === "underutilized";
    return underThreshold || isUnderutilizedState;
  });

  const healthyCount = servers.length - flaggedServers.length;
  const statusInfo = summary ? pueTone(summary.pue) : { class: "neutral", label: "—" };

  // Calculate top flag threshold metric context
  const topFlagServer = topFlag ? servers.find((s) => s.server_id === topFlag.server_id) : null;
  const topFlagThreshold = topFlagServer && thresholds[topFlagServer.server_type]
    ? thresholds[topFlagServer.server_type].idle_cpu_threshold
    : null;
  const metricDetails = topFlag
    ? formatRecordedMetric(topFlag.flag_type, topFlag.metric_value, topFlagThreshold)
    : { main: "—", sub: "" };

  return (
    <div className="overview-clean-container">
      <style>{`
        .overview-clean-container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 8px 0 32px 0;
        }

        /* Top Header Strip */
        .header-strip {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          margin-bottom: 20px;
        }

        .header-title-group h1 {
          font-size: 24px;
          font-weight: 700;
          color: var(--text-primary, #1C2622);
          margin: 0 0 4px 0;
        }

        .header-title-group p {
          font-size: 13.5px;
          color: var(--text-secondary, #5F6E68);
          margin: 0;
        }

        .time-pill-group {
          display: flex;
          align-items: center;
          gap: 4px;
          background: #FFFFFF;
          border: 1px solid var(--border, #E3ECE8);
          padding: 3px;
          border-radius: 8px;
        }

        .time-pill {
          border: none;
          background: transparent;
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 600;
          color: var(--text-secondary, #5F6E68);
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .time-pill.active {
          background: var(--accent-dark, #0F6E56);
          color: #FFFFFF;
        }

        /* Executive Command Grid */
        .executive-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 16px;
          margin-bottom: 24px;
        }

        .exec-card {
          background: #FFFFFF;
          border: 1px solid var(--border, #E3ECE8);
          border-radius: 12px;
          padding: 18px 20px;
          box-shadow: 0 1px 3px rgba(4, 52, 44, 0.04);
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }

        .exec-card-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }

        .exec-label {
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--text-secondary, #5F6E68);
        }

        .exec-value {
          font-size: 28px;
          font-weight: 700;
          color: var(--text-primary, #1C2622);
          line-height: 1;
          margin-bottom: 6px;
        }

        .exec-subtext {
          font-size: 12px;
          color: var(--text-muted, #8A9691);
          line-height: 1.4;
        }

        /* Facility Workload Status Strip */
        .facility-status-card {
          background: #FFFFFF;
          border: 1px solid var(--border, #E3ECE8);
          border-radius: 12px;
          padding: 14px 18px;
          margin-bottom: 24px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
        }

        .distribution-track {
          flex: 1;
          height: 8px;
          background: var(--page-bg, #F2F8F5);
          border-radius: 4px;
          overflow: hidden;
          display: flex;
        }

        .distribution-segment-good {
          background: var(--accent, #1D9E75);
          height: 100%;
        }

        .distribution-segment-warn {
          background: var(--warn-text, #D9822B);
          height: 100%;
        }

        /* Main Workspace Split */
        .workspace-grid {
          display: grid;
          grid-template-columns: 1.7fr 1fr;
          gap: 20px;
          align-items: start;
        }

        /* Content Card */
        .content-card {
          background: #FFFFFF;
          border: 1px solid var(--border, #E3ECE8);
          border-radius: 12px;
          padding: 20px;
          box-shadow: 0 1px 3px rgba(4, 52, 44, 0.04);
        }

        .content-card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
        }

        .card-heading {
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary, #1C2622);
          margin: 0;
        }

        .card-action-link {
          font-size: 13px;
          font-weight: 600;
          color: var(--accent-dark, #0F6E56);
          text-decoration: none;
        }

        .card-action-link:hover {
          text-decoration: underline;
        }

        /* Action Focal Table */
        .action-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }

        .action-table th {
          text-align: left;
          padding: 10px 12px;
          background: var(--page-bg, #F2F8F5);
          color: var(--text-secondary, #5F6E68);
          font-weight: 600;
          border-bottom: 1px solid var(--border, #E3ECE8);
        }

        .action-table td {
          padding: 12px;
          border-bottom: 1px solid var(--border, #E3ECE8);
          color: var(--text-primary, #1C2622);
        }

        .server-link {
          font-weight: 600;
          color: var(--accent-dark, #0F6E56);
          text-decoration: none;
        }

        .server-link:hover {
          text-decoration: underline;
        }

        .reason-tag {
          font-size: 12px;
          color: var(--warn-text, #854F0B);
          background: var(--warn-bg, #FFFDF9);
          padding: 3px 8px;
          border-radius: 4px;
          display: inline-block;
          font-weight: 500;
        }

        /* Spotlight Recommendation Card */
        .spotlight-card {
          background: linear-gradient(135deg, #04342C 0%, #0F6E56 100%);
          color: #FFFFFF;
          border-radius: 12px;
          padding: 20px;
          box-shadow: 0 4px 12px rgba(4, 52, 44, 0.12);
        }

        .spotlight-tag {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #93E2C3;
          margin-bottom: 8px;
          display: block;
        }

        .spotlight-title {
          font-size: 19px;
          font-weight: 600;
          margin: 0 0 16px 0;
          line-height: 1.3;
        }

        .spotlight-meta-block {
          background: rgba(255, 255, 255, 0.08);
          border-radius: 8px;
          padding: 14px;
          margin-bottom: 16px;
        }

        .spotlight-meta-label {
          font-size: 11px;
          color: #CDEEE1;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin-bottom: 4px;
          display: block;
        }

        .spotlight-meta-main {
          font-size: 18px;
          font-weight: 700;
          color: #FFFFFF;
          margin-bottom: 2px;
        }

        .spotlight-meta-sub {
          font-size: 12px;
          color: #93E2C3;
        }

        .btn-spotlight {
          width: 100%;
          background: #FFFFFF;
          color: var(--sidebar-bg, #04342C);
          border: none;
          padding: 11px;
          border-radius: 8px;
          font-size: 13.5px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s ease;
          text-align: center;
          text-decoration: none;
          display: block;
        }

        .btn-spotlight:hover {
          background: #E8F2EE;
        }

        @media (max-width: 1024px) {
          .executive-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }

        @media (max-width: 768px) {
          .executive-grid,
          .workspace-grid {
            grid-template-columns: 1fr;
          }

          .header-strip,
          .facility-status-card {
            flex-direction: column;
            align-items: flex-start;
          }
        }
      `}</style>

      {/* HEADER STRIP */}
      <div className="header-strip">
        <div className="header-title-group">
          <h1>Infrastructure Command</h1>
          <p>Real-time telemetry overview and active optimization targets.</p>
        </div>

        <div className="time-pill-group">
          {[1, 6, 12, 24].map((hours) => (
            <button
              key={hours}
              className={`time-pill ${windowHours === hours ? "active" : ""}`}
              onClick={() => setWindowHours(hours)}
            >
              {hours}h Window
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="empty-state">{error}</div>
      ) : !summary ? (
        <div className="empty-state">Loading infrastructure metrics...</div>
      ) : (
        <>
          {/* EXECUTIVE COMMAND STRIP */}
          <div className="executive-grid">
            <div className="exec-card">
              <div className="exec-card-top">
                <span className="exec-label">Facility Power Draw</span>
                <span className="badge neutral">Telemetry</span>
              </div>
              <div className="exec-value">{summary.avg_facility_power_kw} <span style={{ fontSize: 16 }}>kW</span></div>
              <div className="exec-subtext">Real-time IT &amp; cooling power draw across facility.</div>
            </div>

            <div className="exec-card">
              <div className="exec-card-top">
                <span className="exec-label">Facility PUE</span>
                <span className={`badge ${statusInfo.class}`}>{statusInfo.label}</span>
              </div>
              <div className="exec-value">{summary.pue}</div>
              <div className="exec-subtext">{(summary.pue - 1).toFixed(2)} overhead ratio over ideal IT load ({windowHours}h avg).</div>
            </div>

            <div className="exec-card">
              <div className="exec-card-top">
                <span className="exec-label">Carbon Footprint Rate</span>
                <span className="badge neutral">{summary.emission_factor_kg_per_kwh != null ? `${summary.emission_factor_kg_per_kwh} kg/kWh Grid` : "Grid factor"}</span>
              </div>
              <div className="exec-value">{summary.emission_factor_kg_per_kwh != null ? (summary.avg_facility_power_kw * summary.emission_factor_kg_per_kwh).toFixed(1) : "—"} <span style={{ fontSize: 16 }}>kg/hr</span></div>
              <div className="exec-subtext">Calculated as: Power Draw (kW) × Grid Carbon Intensity.</div>
            </div>

            <div className="exec-card">
              <div className="exec-card-top">
                <span className="exec-label">Action Candidates</span>
                <span className={`badge ${flaggedServers.length > 0 ? "warn" : "good"}`}>
                  {flaggedServers.length} Flagged
                </span>
              </div>
              <div className="exec-value">{flaggedServers.length} <span style={{ fontSize: 16 }}>Servers</span></div>
              <div className="exec-subtext">Servers sitting below utilization cutoff baselines.</div>
            </div>
          </div>

          {/* FACILITY WORKLOAD STATUS BAR */}
          <div className="facility-status-card">
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              Data Center Load Balance:
            </div>

            <div className="distribution-track">
              <div
                className="distribution-segment-good"
                style={{ width: `${(healthyCount / (servers.length || 1)) * 100}%` }}
                title={`${healthyCount} Healthy Servers`}
              />
              <div
                className="distribution-segment-warn"
                style={{ width: `${(flaggedServers.length / (servers.length || 1)) * 100}%` }}
                title={`${flaggedServers.length} Underutilized Servers`}
              />
            </div>

            <div style={{ fontSize: 12.5, color: "var(--text-secondary)", display: "flex", gap: 12 }}>
              <span>● <strong>{healthyCount}</strong> Optimal</span>
              <span style={{ color: "var(--warn-text)" }}>● <strong>{flaggedServers.length}</strong> Underutilized</span>
            </div>
          </div>

          {/* WORKSPACE SPLIT */}
          <div className="workspace-grid">
            {/* ACTION REQUIRED TABLE */}
            <div className="content-card">
              <div className="content-card-header">
                <h2 className="card-heading">Nodes Requiring Attention ({flaggedServers.length})</h2>
                <Link to="/servers" className="card-action-link">
                  All Data Center Servers ({servers.length}) →
                </Link>
              </div>

              {flaggedServers.length === 0 ? (
                <div className="empty-state" style={{ padding: "2.5rem 1rem" }}>
                  All nodes are currently operating within optimal utilization parameters.
                </div>
              ) : (
                <table className="action-table">
                  <thead>
                    <tr>
                      <th>Node ID</th>
                      <th>Type</th>
                      <th>{windowHours}h Rolling Avg</th>
                      <th>Flagged Deficit Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flaggedServers.map((s) => {
                      const t = thresholds[s.server_type];
                      const thresholdVal = t ? t.idle_cpu_threshold : 20;
                      const avgVal = s.avg_cpu ?? s.cpu;
                      const isUnder = avgVal < thresholdVal;

                      return (
                        <tr key={s.server_id}>
                          <td>
                            <Link to={`/servers/${s.server_id}`} className="server-link">
                              {s.server_id}
                            </Link>
                          </td>
                          <td style={{ color: "var(--text-secondary)" }}>{s.server_type}</td>
                          <td>
                            <strong>{avgVal}% CPU</strong>
                          </td>
                          <td>
                            <span className="reason-tag">
                              {isUnder
                                ? `${avgVal}% avg vs ${thresholdVal}% cutoff (-${(thresholdVal - avgVal).toFixed(1)}pts)`
                                : s.state}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* FEATURED RECOMMENDATION SPOTLIGHT */}
            <div className="spotlight-card">
              <span className="spotlight-tag">Top Priority Action Target</span>
              {topFlag ? (
                <>
                  <h3 className="spotlight-title">
                    Consolidate Workload on {topFlag.server_id}
                  </h3>

                  <div className="spotlight-meta-block">
                    <span className="spotlight-meta-label">Current Telemetry (6h Rolling Avg)</span>
                    <div className="spotlight-meta-main">{metricDetails.main}</div>
                    <div className="spotlight-meta-sub">{metricDetails.sub}</div>
                  </div>

                  <div className="spotlight-meta-block" style={{ marginBottom: 20 }}>
                    <span className="spotlight-meta-label">Action Priority &amp; Type</span>
                    <div className="spotlight-meta-main" style={{ textTransform: "capitalize", fontSize: 16 }}>
                      {topFlag.severity} Priority · Workload Consolidation
                    </div>
                    <div className="spotlight-meta-sub">
                      Migrates active jobs to target node with safe headroom
                    </div>
                  </div>

                  <Link to="/recommendations" className="btn-spotlight">
                    Review What-If Simulation →
                  </Link>
                </>
              ) : (
                <div style={{ padding: "1rem 0" }}>
                  <p style={{ color: "#CDEEE1", margin: 0 }}>
                    No active waste flags detected across the facility. All systems optimal.
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}