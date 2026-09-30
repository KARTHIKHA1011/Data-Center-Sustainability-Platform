import React, { useEffect, useState } from "react";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

import api from "../api";
import ComplianceReadiness from "./ComplianceReadiness";

/* ==========================================================================
   1. UTILITY FUNCTIONS
   ========================================================================== */

function formatNumber(value, digits = 2) {
  if (
    value === null ||
    value === undefined ||
    Number.isNaN(Number(value))
  ) {
    return "—";
  }

  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: digits,
  });
}

function formatCurrency(value) {
  if (
    value === null ||
    value === undefined ||
    Number.isNaN(Number(value))
  ) {
    return "—";
  }

  return `₹${Number(value).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`;
}

function actionBadgeClass(action) {
  if (
    ["consolidate", "rightsize", "accepted"].includes(action)
  ) {
    return "good";
  }

  if (action === "snooze") {
    return "warn";
  }

  if (action === "do_nothing") {
    return "danger";
  }

  return "neutral";
}

function actionLabel(action) {
  return (
    {
      consolidate: "Consolidated",
      rightsize: "Rightsized",
      snooze: "Snoozed",
      do_nothing: "Dismissed",
      accepted: "Accepted",
    }[action] || action
  );
}

function formatDate(timestamp) {
  if (!timestamp) {
    return "—";
  }

  const utcTimestamp = timestamp.endsWith("Z")
    ? timestamp
    : `${timestamp}Z`;

  return new Date(utcTimestamp).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDayLabel(dateString) {
  if (!dateString) {
    return "";
  }

  const date = new Date(`${dateString}T00:00:00`);

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

/* ==========================================================================
   2. ENVIRONMENTAL PERFORMANCE
   ========================================================================== */

function EnvironmentalSummary({ environmental, avgPue }) {
  return (
    <div className="section-block">

      <p className="section-label">
        Environmental Performance
      </p>

      <div className="metric-grid four-columns">

        {/* ENERGY */}

        <div className="metric-card">

          <p className="metric-label">
            Energy Consumed
          </p>

          <p className="metric-value">
            {formatNumber(environmental?.energy_kwh)}

            <span className="unit">
              {" "}kWh
            </span>
          </p>

          <p className="metric-hint">
            Integrated from facility-power telemetry
          </p>

        </div>


        {/* CARBON */}

        <div className="metric-card">

          <p className="metric-label">
            Carbon Emissions
          </p>

          <p className="metric-value">
            {formatNumber(environmental?.carbon_kg)}

            <span className="unit">
              {" "}kg CO₂e
            </span>
          </p>

          <p className="metric-hint">
            Based on configured grid intensity
          </p>

        </div>


        {/* PUE */}

        <div className="metric-card">

          <p className="metric-label">
            Average PUE
          </p>

          <p className="metric-value">
            {formatNumber(avgPue, 3)}
          </p>

          <p className="metric-hint">
            Facility power / IT power
          </p>

        </div>


        {/* WATER */}

        <div className="metric-card">

          <p className="metric-label">
            Estimated Water Usage
          </p>

          <p className="metric-value">
            {formatNumber(
              environmental?.water_liters
            )}

            <span className="unit">
              {" "}L
            </span>
          </p>

          <p className="metric-hint">
            Based on cooling-specific WUE factors
          </p>

        </div>

      </div>

    </div>
  );
}


/* ==========================================================================
   3. OPERATIONAL EFFICIENCY
   ========================================================================== */

function EfficiencySummary({ efficiency }) {
  return (
    <div className="section-block">

      <p className="section-label">
        Operational Efficiency
      </p>

      <div className="metric-grid four-columns">

        {/* CPU */}

        <div className="metric-card">

          <p className="metric-label">
            Average CPU
          </p>

          <p className="metric-value">
            {formatNumber(
              efficiency?.avg_cpu
            )}

            <span className="unit">
              {" "}%  
            </span>
          </p>

          <p className="metric-hint">
            Fleet-wide workload utilization
          </p>

        </div>


        {/* MEMORY */}

        <div className="metric-card">

          <p className="metric-label">
            Average Memory
          </p>

          <p className="metric-value">
            {formatNumber(
              efficiency?.avg_memory
            )}

            <span className="unit">
              {" "}%  
            </span>
          </p>

          <p className="metric-hint">
            Fleet-wide memory utilization
          </p>

        </div>


        {/* COOLING */}

        <div className="metric-card">

          <p className="metric-label">
            Cooling Efficiency
          </p>

          <p className="metric-value">
            {formatNumber(
              efficiency?.avg_cooling_efficiency
            )}

            <span className="unit">
              {" "}%  
            </span>
          </p>

          <p className="metric-hint">
            Average reported cooling efficiency
          </p>

        </div>


        {/* UNDERUTILIZED */}

        <div className="metric-card neutral">

          <p className="metric-label">
            Underutilized Servers
          </p>

          <p className="metric-value">
            {efficiency?.underutilized_servers ?? 0}
          </p>

          <p className="metric-hint">
            Servers below their configured utilization threshold
          </p>

        </div>

      </div>

    </div>
  );
}


/* ==========================================================================
   4. ENERGY & CARBON TREND
   ========================================================================== */

function EnvironmentalTrend({ daily }) {

  const chartData = (daily || [])
    .filter((row) => {

      if (row.has_data === false) {
        return false;
      }

      return (
        Number(row.energy_kwh || 0) > 0 ||
        Number(row.carbon_kg || 0) > 0
      );
    })
    .map((row) => ({
      ...row,
      label: formatDayLabel(row.date),
    }));


  if (!chartData.length) {
    return (
      <div className="card">

        <div className="card-header-row">

          <div>

            <h3 className="card-title">
              Energy & Carbon Trend
            </h3>

            <p className="card-subtitle">
              Daily environmental performance
            </p>

          </div>

        </div>

        <div className="empty-state">
          No telemetry available for this reporting period.
        </div>

      </div>
    );
  }


  return (
    <div className="trend-grid">

      {/* ================================================================
          ENERGY
      ================================================================ */}

      <div className="card">

        <div className="card-header-row">

          <div>

            <h3 className="card-title">
              Energy Consumption
            </h3>

            <p className="card-subtitle">
              Daily facility energy usage
            </p>

          </div>

        </div>


        <ResponsiveContainer
          width="100%"
          height={280}
        >

          <AreaChart data={chartData}>

            <defs>

              <linearGradient
                id="esgEnergyFill"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >

                <stop
                  offset="0%"
                  stopColor="#1D9E75"
                  stopOpacity={0.75}
                />

                <stop
                  offset="100%"
                  stopColor="#1D9E75"
                  stopOpacity={0.12}
                />

              </linearGradient>

            </defs>


            <CartesianGrid
              stroke="#C8DED5"
              strokeDasharray="3 3"
              vertical={false}
            />


            <XAxis
              dataKey="label"
              fontSize={12}
              stroke="#1C2622"
              tickLine={false}
            />


            <YAxis
              fontSize={12}
              stroke="#1C2622"
              tickLine={false}
              unit=" kWh"
            />


            <Tooltip />


            <Area
              type="monotone"
              dataKey="energy_kwh"
              stroke="#0F6E56"
              strokeWidth={3}
              fill="url(#esgEnergyFill)"
              name="Energy (kWh)"
            />

          </AreaChart>

        </ResponsiveContainer>

      </div>


      {/* ================================================================
          CARBON
      ================================================================ */}

      <div className="card">

        <div className="card-header-row">

          <div>

            <h3 className="card-title">
              Carbon Emissions
            </h3>

            <p className="card-subtitle">
              Estimated daily carbon footprint
            </p>

          </div>

        </div>


        <ResponsiveContainer
          width="100%"
          height={280}
        >

          <LineChart data={chartData}>

            <CartesianGrid
              stroke="#C8DED5"
              strokeDasharray="3 3"
              vertical={false}
            />


            <XAxis
              dataKey="label"
              fontSize={12}
              stroke="#1C2622"
              tickLine={false}
            />


            <YAxis
              fontSize={12}
              stroke="#1C2622"
              tickLine={false}
              unit=" kg"
            />


            <Tooltip />


            <Line
              type="monotone"
              dataKey="carbon_kg"
              stroke="#D9822B"
              strokeWidth={3}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
              name="Carbon (kg CO₂e)"
            />

          </LineChart>

        </ResponsiveContainer>

      </div>

    </div>
  );
}


/* ==========================================================================
   5. PUE / CPU EFFICIENCY TREND
   ========================================================================== */

function EfficiencyTrend({ daily }) {

  const chartData = (daily || [])
    .filter((row) => {

      return (
        row.has_data !== false &&
        row.avg_pue !== null &&
        row.avg_pue !== undefined &&
        Number(row.avg_pue) > 0
      );

    })
    .map((row) => ({
      ...row,
      label: formatDayLabel(row.date),
    }));


  if (!chartData.length) {
    return null;
  }


  return (
    <div className="card">

      <div className="card-header-row">

        <div>

          <h3 className="card-title">
            Datacenter Efficiency Trend
          </h3>

          <p className="card-subtitle">
            Daily PUE and operational utilization
          </p>

        </div>

      </div>


      <ResponsiveContainer
        width="100%"
        height={280}
      >

        <LineChart data={chartData}>

          <CartesianGrid
            stroke="#C8DED5"
            strokeDasharray="3 3"
            vertical={false}
          />


          <XAxis
            dataKey="label"
            fontSize={12}
            stroke="#1C2622"
            tickLine={false}
          />


          <YAxis
            yAxisId="left"
            fontSize={12}
            stroke="#1C2622"
            tickLine={false}
          />


          <YAxis
            yAxisId="right"
            orientation="right"
            fontSize={12}
            stroke="#1C2622"
            tickLine={false}
            unit="%"
          />


          <Tooltip />


          <Legend
            verticalAlign="top"
            height={36}
          />


          <Line
            yAxisId="left"
            type="monotone"
            dataKey="avg_pue"
            stroke="#0F6E56"
            strokeWidth={3}
            dot={{ r: 3 }}
            name="PUE"
          />


          <Line
            yAxisId="right"
            type="monotone"
            dataKey="avg_cpu"
            stroke="#D9822B"
            strokeWidth={2}
            dot={{ r: 3 }}
            name="CPU (%)"
          />

        </LineChart>

      </ResponsiveContainer>

    </div>
  );
}


/* ==========================================================================
   6. OPTIMIZATION IMPACT
   ========================================================================== */

function OptimizationImpact({ optimization }) {

  const accepted =
    optimization?.accepted_actions || 0;


  return (
    <div className="section-block">

      <div className="card">

        <div className="card-header-row">

          <div>

            <h3 className="card-title">
              Optimization Impact
            </h3>

            <p className="card-subtitle">
              Environmental and financial impact estimated
              from accepted GreenOps recommendations.
            </p>

          </div>


          <span className="badge neutral">
            {accepted} Accepted
          </span>

        </div>


        {accepted === 0 ? (

          <div className="optimization-empty">

            <div className="empty-icon">
              —
            </div>

            <div>

              <strong>
                No optimization actions accepted
              </strong>

              <p>
                Environmental baseline metrics above are still
                available because ESG reporting is independent
                of operator decisions.
              </p>

            </div>

          </div>

        ) : (

          <div className="metric-grid four-columns">

            {/* ENERGY SAVED */}

            <div className="metric-card">

              <p className="metric-label">
                Energy Saved
              </p>

              <p className="metric-value">

                {formatNumber(
                  optimization?.energy_saved_kwh
                )}

                <span className="unit">
                  {" "}kWh
                </span>

              </p>

              <p className="metric-hint">
                Estimated from accepted recommendation snapshots
              </p>

            </div>


            {/* CARBON REDUCED */}

            <div className="metric-card">

              <p className="metric-label">
                Carbon Reduced
              </p>

              <p className="metric-value">

                {formatNumber(
                  optimization?.carbon_reduced_kg
                )}

                <span className="unit">
                  {" "}kg
                </span>

              </p>

              <p className="metric-hint">
                Estimated reduction in CO₂e
              </p>

            </div>


            {/* COST SAVED */}

            <div className="metric-card">

              <p className="metric-label">
                Cost Saved
              </p>

              <p className="metric-value">

                {formatCurrency(
                  optimization?.cost_saved
                )}

              </p>

              <p className="metric-hint">
                Estimated using configured electricity tariff
              </p>

            </div>


            {/* STORAGE */}

            <div className="metric-card neutral">

              <p className="metric-label">
                Storage Reclaimed
              </p>

              <p className="metric-value">

                {formatNumber(
                  optimization?.storage_reclaimed_gb
                )}

                <span className="unit">
                  {" "}GB
                </span>

              </p>

              <p className="metric-hint">
                Estimated from accepted storage actions
              </p>

            </div>

          </div>

        )}

      </div>

    </div>
  );
}


/* ==========================================================================
   7. DECISION SUMMARY
   ========================================================================== */

function DecisionSummary({ decisionCounts }) {

  return (
    <div className="section-block">

      <p className="section-label">
        Operator Decision Summary
      </p>


      <div className="metric-grid four-columns">

        {/* TOTAL */}

        <div className="metric-card neutral">

          <p className="metric-label">
            Total Decisions
          </p>

          <p className="metric-value">
            {decisionCounts?.total || 0}
          </p>

        </div>


        {/* ACCEPTED */}

        <div className="metric-card">

          <p className="metric-label">
            Accepted
          </p>

          <p className="metric-value">
            {decisionCounts?.accepted || 0}
          </p>

        </div>


        {/* SNOOZED */}

        <div className="metric-card">

          <p className="metric-label">
            Snoozed
          </p>

          <p className="metric-value">
            {decisionCounts?.snoozed || 0}
          </p>

        </div>


        {/* DISMISSED */}

        <div className="metric-card">

          <p className="metric-label">
            Dismissed
          </p>

          <p className="metric-value">
            {decisionCounts?.rejected || 0}
          </p>

        </div>

      </div>

    </div>
  );
}


/* ==========================================================================
   8. DECISION AUDIT TABLE
   ========================================================================== */

function DecisionAuditTable({ decisions }) {

  return (
    <div className="card">

      <div className="card-header-row">

        <div>

          <h3 className="card-title">
            Decision Audit Trail
          </h3>

          <p className="card-subtitle">
            Operator decisions captured at the time
            recommendations were reviewed.
          </p>

        </div>


        <span className="badge neutral">
          {decisions.length} Records Logged
        </span>

      </div>


      {decisions.length === 0 ? (

        <div className="empty-state">
          No operator decisions recorded within this timeframe.
        </div>

      ) : (

        <div className="table-scroll">

          <table className="data-table">

            <thead>

              <tr>

                <th>
                  Timestamp
                </th>

                <th>
                  Server
                </th>

                <th>
                  Target
                </th>

                <th>
                  Action
                </th>

                <th style={{ textAlign: "right" }}>
                  Energy Impact
                </th>

                <th style={{ textAlign: "right" }}>
                  Carbon Impact
                </th>

                <th style={{ textAlign: "right" }}>
                  Cost Impact
                </th>

              </tr>

            </thead>


            <tbody>

              {decisions.map((d) => (

                <tr key={d.id}>

                  <td>
                    {formatDate(d.created_at)}
                  </td>


                  <td className="row-title">
                    {d.server_id}
                  </td>


                  <td className="row-meaning">
                    {d.target_server_id || "—"}
                  </td>


                  <td>

                    <span
                      className={`badge ${actionBadgeClass(
                        d.action
                      )}`}
                    >
                      {actionLabel(d.action)}
                    </span>

                  </td>


                  <td
                    style={{
                      textAlign: "right",
                    }}
                  >

                    {d.estimated_energy_saving_kwh !==
                      null &&
                    d.estimated_energy_saving_kwh !==
                      undefined
                      ? `${formatNumber(
                          d.estimated_energy_saving_kwh
                        )} kWh`
                      : "—"}

                  </td>


                  <td
                    style={{
                      textAlign: "right",
                    }}
                  >

                    {d.estimated_carbon_reduction_kg !==
                      null &&
                    d.estimated_carbon_reduction_kg !==
                      undefined
                      ? `${formatNumber(
                          d.estimated_carbon_reduction_kg
                        )} kg`
                      : "—"}

                  </td>


                  <td
                    style={{
                      textAlign: "right",
                      fontWeight: 600,
                    }}
                  >

                    {d.estimated_cost_saving !==
                      null &&
                    d.estimated_cost_saving !==
                      undefined
                      ? formatCurrency(
                          d.estimated_cost_saving
                        )
                      : "—"}

                  </td>

                </tr>

              ))}

            </tbody>

          </table>

        </div>

      )}

    </div>
  );
}


/* ==========================================================================
   9. MAIN PAGE
   ========================================================================== */

export default function Reports() {

  const [days, setDays] = useState(30);

  const [report, setReport] = useState(null);

  const [loading, setLoading] = useState(true);

  const [error, setError] = useState("");


  /* ------------------------------------------------------------------------
     LOAD REPORT
  ------------------------------------------------------------------------ */

  const load = async (rangeDays) => {

    try {

      setLoading(true);

      setError("");

      const response =
        await api.esgReport(rangeDays);

      console.log("ESG REPORT RESPONSE:", response.data);

      setReport(response.data);

    } catch (err) {

      console.error(err);

      setError(
        "Failed to generate ESG sustainability report."
      );

    } finally {

      setLoading(false);

    }

  };


  useEffect(() => {

    load(days);

  }, [days]);


  /*
   * IMPORTANT:
   *
   * Backend structure:
   *
   * report.operational_efficiency.avg_pue
   *
   * We explicitly extract PUE here and pass it into the
   * EnvironmentalSummary component.
   */

  const avgPue =
    report?.operational_efficiency?.avg_pue ??
    report?.avg_pue ??
    null;


  return (
    <>
      <style>{`

        /* ================================================================
           REPORT CONTAINER
        ================================================================ */

        .reports-container {

          max-width: 1200px;

          margin: 0 auto;

          padding: 8px 0 40px 0;

        }


        /* ================================================================
           HEADER
        ================================================================ */

        .reports-header {

          display: flex;

          justify-content: space-between;

          align-items: flex-start;

          gap: 16px;

          margin-bottom: 20px;

        }


        .reports-header-actions {

          display: flex;

          gap: 8px;

          flex-wrap: wrap;

        }


        /* ================================================================
           FILTER ROW
        ================================================================ */

        .reports-filter-row {

          display: flex;

          justify-content: space-between;

          align-items: center;

          gap: 12px;

          margin-bottom: 28px;

        }


        .range-button-group {

          display: flex;

          gap: 6px;

          background: var(--card-bg);

          border: 1px solid var(--border);

          padding: 4px;

          border-radius: 8px;

        }


        .range-btn {

          border: none;

          background: transparent;

          padding: 6px 14px;

          font-size: 12.5px;

          font-weight: 500;

          color: var(--text-secondary);

          border-radius: 6px;

          cursor: pointer;

          transition: all 0.15s ease;

        }


        .range-btn.active {

          background: var(--accent-dark);

          color: #FFFFFF;

        }


        .range-btn:hover:not(.active) {

          background: var(--sidebar-bg);

        }


        /* ================================================================
           UNITS
        ================================================================ */

        .unit {

          font-size: 14px;

          color: var(--text-muted);

          font-weight: normal;

        }


        .metric-sub-detail {

          font-size: 12px;

          color: var(--text-secondary);

          margin-top: 6px;

        }


        /* ================================================================
           METRIC GRID
        ================================================================ */

        .four-columns {

          grid-template-columns:
            repeat(4, minmax(0, 1fr));

        }


        /* ================================================================
           TREND GRID
        ================================================================ */

        .trend-grid {

          display: grid;

          grid-template-columns:
            repeat(2, minmax(0, 1fr));

          gap: 16px;

          margin-bottom: 20px;

        }


        /* ================================================================
           SECTIONS
        ================================================================ */

        .section-block {

          margin-bottom: 20px;

        }


        .section-label {

          margin-bottom: 10px;

        }


        /* ================================================================
           CARD HEADER
        ================================================================ */

        .card-header-row {

          display: flex;

          justify-content: space-between;

          align-items: flex-start;

          gap: 16px;

          margin-bottom: 16px;

        }


        /* ================================================================
           EXPORT BUTTONS
        ================================================================ */

        .export-button {

          padding: 8px 14px;

          border-radius: 8px;

          font-size: 12.5px;

          font-weight: 500;

          cursor: pointer;

          transition: all 0.15s ease;

          border: 1px solid var(--accent-dark);

          text-decoration: none;

          display: inline-flex;

          align-items: center;

          justify-content: center;

          gap: 6px;

          white-space: nowrap;

        }


        .export-button.csv {

          background: var(--card-bg);

          color: var(--text-primary);

          border-color: var(--border);

        }


        .export-button.csv:hover {

          background: var(--sidebar-bg);

        }


        .export-button.pdf {

          background: var(--accent-dark);

          color: #FFFFFF;

          border-color: var(--accent-dark);

        }


        .export-button.pdf:hover {

          opacity: 0.9;

        }


        /* ================================================================
           INFO NOTE
        ================================================================ */

        .info-note {

          font-size: 13px;

          color: var(--text-secondary);

          background: #F4F8F6;

          border: 1px solid #DCEFE7;

          border-radius: 8px;

          padding: 14px 16px;

          margin-top: 20px;

          line-height: 1.6;

        }


        /* ================================================================
           OPTIMIZATION EMPTY
        ================================================================ */

        .optimization-empty {

          display: flex;

          align-items: center;

          gap: 14px;

          border: 1px dashed var(--border);

          border-radius: 10px;

          padding: 18px;

          background: var(--card-bg);

        }


        .optimization-empty p {

          margin: 5px 0 0;

          color: var(--text-secondary);

          font-size: 13px;

          line-height: 1.5;

        }


        .empty-icon {

          width: 38px;

          height: 38px;

          border-radius: 50%;

          display: flex;

          align-items: center;

          justify-content: center;

          background: var(--sidebar-bg);

          color: var(--text-secondary);

          font-weight: 700;

        }


        /* ================================================================
           TABLE
        ================================================================ */

        .table-scroll {

          overflow-x: auto;

        }


        /* ================================================================
           RESPONSIVE
        ================================================================ */

        @media (max-width: 900px) {

          .four-columns {

            grid-template-columns:
              repeat(2, minmax(0, 1fr));

          }


          .trend-grid {

            grid-template-columns: 1fr;

          }

        }


        @media (max-width: 768px) {

          .reports-header,
          .reports-filter-row,
          .card-header-row {

            flex-direction: column;

            align-items: flex-start;

          }


          .reports-header-actions {

            width: 100%;

          }


          .export-button {

            flex: 1;

          }


          .reports-filter-row {

            gap: 16px;

          }


          .four-columns {

            grid-template-columns: 1fr;

          }


          .range-button-group {

            width: 100%;

            overflow-x: auto;

          }

        }

      `}</style>


      <div className="reports-container">

        {/* ================================================================
            HEADER
        ================================================================ */}

        <div className="reports-header">

          <div>

            <h1 className="page-title">
              ESG &amp; Sustainability Report
            </h1>

            <p className="page-subtitle">
              Environmental performance, infrastructure
              efficiency, and sustainability impact for the
              selected reporting period.
            </p>

          </div>


          {/* ============================================================
              EXPORT BUTTONS
          ============================================================ */}

          <div className="reports-header-actions">

            {/* CSV */}

            <a
              className="export-button csv"
              href={api.esgReportExportUrl(days)}
              target="_blank"
              rel="noopener noreferrer"
            >

              <span>
                ↓
              </span>

              Export CSV

            </a>


            {/* PDF */}

            <a
              className="export-button pdf"
              href={api.esgReportPdfUrl(days)}
              target="_blank"
              rel="noopener noreferrer"
            >

              <span>
                ↓
              </span>

              Export PDF

            </a>

          </div>

        </div>


        {/* ================================================================
            ERROR
        ================================================================ */}

        {error && (

          <div className="error-banner">
            {error}
          </div>

        )}


        {/* ================================================================
            REPORTING PERIOD
        ================================================================ */}

        <div className="reports-filter-row">

          <div className="range-button-group">

            {[7, 30, 90].map((d) => (

              <button
                key={d}
                className={`range-btn ${
                  d === days ? "active" : ""
                }`}
                onClick={() => setDays(d)}
              >

                Past {d} Days

              </button>

            ))}

          </div>


          <span className="section-context">

            Reporting scope: {days} days relative to current
            time

          </span>

        </div>


        {/* ================================================================
            LOADING
        ================================================================ */}

        {loading && !report ? (

          <div className="empty-state">

            Generating ESG sustainability report...

          </div>

        ) : (

          <>

            {/* ============================================================
                ENVIRONMENTAL PERFORMANCE
            ============================================================ */}

            <EnvironmentalSummary
              environmental={
                report?.environmental
              }

              /*
               * FIXED:
               * PUE comes from operational_efficiency.avg_pue
               */
              avgPue={avgPue}
            />


            {/* ============================================================
                OPERATIONAL EFFICIENCY
            ============================================================ */}

            <EfficiencySummary
              efficiency={
                report?.operational_efficiency
              }
            />


            {/* ============================================================
                ENERGY + CARBON
            ============================================================ */}

            <EnvironmentalTrend
              daily={
                report?.daily || []
              }
            />


            {/* ============================================================
                PUE + CPU
            ============================================================ */}

            <EfficiencyTrend
              daily={
                report?.daily || []
              }
            />


            {/* ============================================================
                OPTIMIZATION IMPACT
            ============================================================ */}

            <OptimizationImpact
              optimization={
                report?.optimization_impact
              }
            />


            {/* ============================================================
                DECISION SUMMARY
            ============================================================ */}

            <DecisionSummary
              decisionCounts={
                report?.decision_counts
              }
            />


            {/* ============================================================
                AUDIT TRAIL
            ============================================================ */}

            <DecisionAuditTable
              decisions={
                report?.decisions || []
              }
            />


            {/* ============================================================
                COMPLIANCE READINESS (follows the selected date range)
            ============================================================ */}

            <ComplianceReadiness days={days} onSettingsSaved={() => load(days)} />


            {/* ============================================================
                METHODOLOGY
            ============================================================ */}

            <div className="info-note">

              <strong>
                ESG Calculation Methodology:
              </strong>{" "}

              {report?.note ||
                "Environmental metrics are calculated from GreenOps telemetry. Optimization impacts are based on accepted recommendation snapshots."
              }

            </div>

          </>

        )}

      </div>

    </>
  );
}