import { useEffect, useMemo, useRef, useState } from "react";

import { useParams, Link, useNavigate } from "react-router-dom";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
  ReferenceArea,
  Legend,
  BarChart,
  Bar,
  Cell,
} from "recharts";

import api from "../api";

const MAX_HISTORY_HOURS = 24;

// Same factors rules_engine.WUE_FACTORS uses server-side -- kept in sync
// deliberately, since water use depends on THIS server's own cooling type,
// not a fleet-wide average. Never hardcode a single factor for every server.
const WUE_FACTORS = { Air: 0.3, Hybrid: 1.8, Liquid: 0.9 };

/* ==========================================================================
   1. HELPER FUNCTIONS & FORMATTERS
   ========================================================================== */

function formatValue(value, suffix = "") {
  return value === null || value === undefined ? "—" : `${value}${suffix}`;
}

function formatHorizon(minutes) {
  if (!minutes) return "—";
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)}h`;
}

function timeLabel(timestamp) {
  if (!timestamp) return "—";

  const utcTimestamp =
    timestamp.endsWith("Z") ? timestamp : `${timestamp}Z`;

  return new Date(utcTimestamp).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function dedupedTickFormatter(data) {
  return (value, index) =>
    index > 0 && data[index]?.time === data[index - 1]?.time
      ? ""
      : value;
}

function windowData(rawHistory, hours) {
  if (hours >= MAX_HISTORY_HOURS) return rawHistory;

  const cutoff = Date.now() - hours * 3600 * 1000;

  return rawHistory.filter((point) => {
    if (!point.timestamp) return true;

    const utcTimestamp =
      point.timestamp.endsWith("Z")
        ? point.timestamp
        : `${point.timestamp}Z`;

    return new Date(utcTimestamp).getTime() >= cutoff;
  });
}

function flagLabel(flagType) {
  return (
    {
      idle_server: "Idle server",
      stale_data: "Stale data",
      duplicate_data: "Duplicate data",
      overprovisioned: "Over-provisioned",
    }[flagType] || flagType
  );
}

/* ==========================================================================
   2. MAIN PAGE COMPONENT
   ========================================================================== */

export default function ServerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [rawHistory, setRawHistory] = useState([]);
  const [detail, setDetail] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [horizon, setHorizon] = useState(60);
  const [loading, setLoading] = useState(true);

  // The real what-if impact for THIS server's own consolidate recommendation,
  // if it has one -- looked up from the ranked recommendations list.
  const [consolidateImpact, setConsolidateImpact] = useState(null);

  const [cpuHours, setCpuHours] = useState(6);

  const isFirstLoad = useRef(true);

  useEffect(() => {
    let mounted = true;
    isFirstLoad.current = true;

    const load = async () => {
      if (!id) return;

      if (isFirstLoad.current) setLoading(true);

      try {
        const h = await api.serverHistory(id, MAX_HISTORY_HOURS);

        if (!mounted) return;

        const historyData = Array.isArray(h.data)
          ? h.data
          : h.data?.records || [];

        setRawHistory(
          historyData.map((r) => ({
            time: r.timestamp ? timeLabel(r.timestamp) : "—",
            cpu:
              r.cpu === null || r.cpu === undefined
                ? 0
                : Number(r.cpu),
            memory:
              r.memory === null || r.memory === undefined
                ? 0
                : Number(r.memory),
            network:
              r.network_gbps === null || r.network_gbps === undefined
                ? 0
                : Number(r.network_gbps),
            timestamp: r.timestamp,
          }))
        );
      } catch (error) {
        if (mounted && isFirstLoad.current) {
          setRawHistory([]);
        }
      }

      try {
        const d = await api.serverDetail(id);

        if (!mounted) return;

        setDetail(d.data);
      } catch (error) {
        if (mounted && isFirstLoad.current) {
          setDetail(null);
        }
      }

      // Find this server's own consolidate recommendation.
      try {
        const list = await api.recommendations(false);

        if (!mounted) return;

        const own = (list.data || []).find(
          (r) =>
            r.server_id === id &&
            r.recommendation_type === "consolidate"
        );

        setConsolidateImpact(own?.impact || null);
      } catch (error) {
        if (mounted) {
          setConsolidateImpact(null);
        }
      }

      if (mounted) {
        setLoading(false);
        isFirstLoad.current = false;
      }
    };

    load();

    const interval = setInterval(load, 15000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [id]);

  useEffect(() => {
    let mounted = true;

    const loadForecast = async () => {
      if (!id) return;

      try {
        const f = await api.serverForecast(id, horizon);

        if (!mounted) return;

        setForecast(f.data);
      } catch (error) {
        if (mounted) {
          setForecast(null);
        }
      }
    };

    loadForecast();

    const interval = setInterval(loadForecast, 15000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [id, horizon]);

  const cpuData = useMemo(() => {
    const windowed = windowData(rawHistory, cpuHours);
    // Downsample to at most 120 points so the chart stays readable.
    // Keep forecast points (if any) intact — only thin historical readings.
    const MAX_POINTS = 120;
    if (windowed.length <= MAX_POINTS) return windowed;
    const step = Math.ceil(windowed.length / MAX_POINTS);
    return windowed.filter((_, i) => i % step === 0 || i === windowed.length - 1);
  }, [rawHistory, cpuHours]);

  const latest =
    rawHistory.length > 0
      ? rawHistory[rawHistory.length - 1]
      : null;

  const latestCpu = latest ? Number(latest.cpu) : null;

  /* ==========================================================================
     CPU HISTORY INSIGHTS
     ========================================================================== */

  const cpuStats = useMemo(() => {
    if (!cpuData.length) {
      return {
        highest: null,
        lowest: null,
        current: latestCpu,
      };
    }

    const historicalOnly = cpuData.filter(
      (point) => !point.forecast
    );

    if (!historicalOnly.length) {
      return {
        highest: null,
        lowest: null,
        current: latestCpu,
      };
    }

    const highest = historicalOnly.reduce((max, point) =>
      Number(point.cpu) > Number(max.cpu) ? point : max
    );

    const lowest = historicalOnly.reduce((min, point) =>
      Number(point.cpu) < Number(min.cpu) ? point : min
    );

    return {
      highest,
      lowest,
      current: latestCpu,
    };
  }, [cpuData, latestCpu]);

  /*
   * Create separate marker datasets.
   *
   * Each marker is rendered only at its corresponding timestamp.
   * This allows Recharts to place a colored dot directly on the graph.
   */
  const cpuChartData = useMemo(() => {
    if (!cpuData.length) return [];

    const highestTimestamp = cpuStats.highest?.timestamp;
    const lowestTimestamp = cpuStats.lowest?.timestamp;
    const latestTimestamp = latest?.timestamp;

    return cpuData.map((point) => ({
      ...point,

      peak:
        !point.forecast &&
        highestTimestamp &&
        point.timestamp === highestTimestamp
          ? Number(point.cpu)
          : null,

      lowest:
        !point.forecast &&
        lowestTimestamp &&
        point.timestamp === lowestTimestamp
          ? Number(point.cpu)
          : null,

      current:
        !point.forecast &&
        latestTimestamp &&
        point.timestamp === latestTimestamp
          ? Number(point.cpu)
          : null,
    }));
  }, [cpuData, cpuStats.highest, cpuStats.lowest, latest]);

  const forecastChart =
    forecast?.eligible && forecast?.predicted_cpu !== null && latestCpu !== null
      ? [
          ...cpuChartData,
          {
            time: `+${formatHorizon(forecast.horizon_minutes)}`,
            cpu: Number(forecast.predicted_cpu),
            forecast: true,
          },
        ]
      : cpuChartData;

  const power = detail?.power;
  const cooling = detail?.cooling;
  const storage = detail?.storage;
  const flags = detail?.flags || [];

  const idleThreshold = forecast?.idle_threshold ?? null;

  // Real flag only -- never re-derive idleness from the instant CPU reading.
  const isIdleFlagged = flags.some(
    (f) => f.flag_type === "idle_server"
  );

  const diff = forecast
    ? Number(
        (
          forecast.predicted_cpu - forecast.measured_cpu
        ).toFixed(1)
      )
    : 0;

  const diffString =
    diff > 0 ? `+${diff}%` : `${diff}%`;

  // Environmental readings -- current draw only.
  const facilityPowerKw =
    power?.facility_power_kw ?? null;

  const waterFactor = cooling?.cooling_type
    ? WUE_FACTORS[cooling.cooling_type] ?? 0.5
    : null;

  const emissionFactor = detail?.emission_factor_kg_per_kwh ?? null;

  const hourlyCarbonKg =
    facilityPowerKw !== null && emissionFactor !== null
      ? (facilityPowerKw * emissionFactor).toFixed(2)
      : null;

  const hourlyWaterLiters =
    facilityPowerKw !== null && waterFactor !== null
      ? (facilityPowerKw * waterFactor).toFixed(1)
      : null;

  // Storage breakdown.
  const storageBreakdownData = useMemo(() => {
    if (!storage) return [];

    const total = storage.total_storage_gb ?? 0;
    const used = storage.used_storage_gb ?? 0;
    const dup = storage.duplicate_data_gb ?? 0;

    const activeUsed = Math.max(0, used - dup);
    const unused = Math.max(0, total - used);

    return [
      {
        category: "Active data",
        value: Number(activeUsed.toFixed(1)),
        fill: "#1D9E75",
      },
      {
        category: "Duplicate data",
        value: Number(dup.toFixed(1)),
        fill: "#D9822B",
      },
      {
        category: "Unused free space",
        value: Number(unused.toFixed(1)),
        fill: "#B0C4DE",
      },
    ];
  }, [storage]);

  return (
    <div className="server-detail-container">
      <style>{`
        .server-detail-container {
          max-width: 1240px;
          margin: 0 auto;
          padding: 8px 0 32px 0;
        }

        .back-link {
          font-size: 13px;
          color: var(--accent-dark, #0F6E56);
          text-decoration: none;
          font-weight: 600;
          display: inline-block;
          margin-bottom: 8px;
        }

        .back-link:hover {
          text-decoration: underline;
        }

        .server-meta-header {
          background: #FFFFFF;
          border: 1px solid var(--border, #E3ECE8);
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 20px;
          box-shadow: 0 1px 3px rgba(4, 52, 44, 0.04);
        }

        .server-title-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
        }

        .spec-badge-group {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          background: #F4F8F6;
          padding: 12px 16px;
          border-radius: 8px;
          border: 1px solid #DCEFE7;
        }

        .spec-item {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 110px;
        }

        .spec-label {
          font-size: 11px;
          font-weight: 700;
          color: var(--text-secondary, #5F6E68);
          text-transform: uppercase;
        }

        .spec-value {
          font-size: 14px;
          font-weight: 700;
          color: var(--text-primary, #1C2622);
        }

        .section-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .section-title {
          font-size: 14px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--text-secondary, #5F6E68);
          margin: 0;
        }

        .status-banner {
          background: #FFFFFF;
          border: 1px solid var(--border, #E3ECE8);
          border-radius: 12px;
          padding: 18px 22px;
          margin-bottom: 24px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 20px;
          box-shadow: 0 1px 3px rgba(4, 52, 44, 0.04);
        }

        .status-banner.warn {
          border-left: 5px solid #D9822B;
        }

        .status-banner.good {
          border-left: 5px solid #1D9E75;
        }

        .banner-title {
          font-size: 17px;
          font-weight: 700;
          color: var(--text-primary, #1C2622);
          margin: 0 0 4px 0;
        }

        .banner-subtext {
          font-size: 13.5px;
          color: var(--text-secondary, #5F6E68);
          margin: 0;
        }

        .btn-action-primary {
          background: var(--accent-dark, #0F6E56);
          color: #FFFFFF;
          border: none;
          padding: 10px 18px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.15s ease;
        }

        .btn-action-primary:hover {
          background: var(--sidebar-bg, #04342C);
        }

        .env-impact-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
          margin-bottom: 24px;
        }

        .env-card {
          background: #FFFFFF;
          border: 1.5px solid #C8DED5;
          border-radius: 10px;
          padding: 16px 20px;
          box-shadow: 0 1px 3px rgba(4, 52, 44, 0.03);
        }

        .env-label {
          font-size: 11.5px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--text-secondary, #5F6E68);
          margin-bottom: 6px;
        }

        .env-value {
          font-size: 26px;
          font-weight: 700;
          color: var(--text-primary, #1C2622);
          margin-bottom: 4px;
        }

        .env-subtext {
          font-size: 12px;
          color: var(--text-muted, #8A9691);
        }

        .forecast-card {
          background: #FFFFFF;
          border: 1px solid var(--border, #E3ECE8);
          border-radius: 12px;
          padding: 22px;
          margin-bottom: 24px;
          box-shadow: 0 1px 3px rgba(4, 52, 44, 0.04);
        }

        .forecast-pipeline-grid {
          display: grid;
          grid-template-columns: 1.2fr 1fr 1fr;
          gap: 16px;
          margin-top: 16px;
        }

        .pipeline-card {
          background: #FAFCFB;
          border: 1px solid #C8DED5;
          border-radius: 10px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }

        .pipeline-tag {
          font-size: 11px;
          font-weight: 700;
          color: var(--accent-dark, #0F6E56);
          text-transform: uppercase;
          margin-bottom: 6px;
        }

        .pipeline-main-val {
          font-size: 22px;
          font-weight: 700;
          color: var(--text-primary, #1C2622);
          margin-bottom: 4px;
        }

        .pipeline-desc {
          font-size: 12px;
          color: var(--text-secondary, #5F6E68);
          line-height: 1.4;
        }

        .two-col-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin-bottom: 24px;
        }

        /* ==============================================================
           CPU GRAPH INSIGHT SUMMARY
           ============================================================== */

        .cpu-insight-strip {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 10px;
          margin-bottom: 14px;
        }

        .cpu-insight {
          border: 1px solid #DCE7E2;
          background: #FAFCFB;
          border-radius: 8px;
          padding: 9px 12px;
          display: flex;
          align-items: center;
          gap: 9px;
        }

        .cpu-insight-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
        }

        .cpu-insight-label {
          font-size: 10.5px;
          font-weight: 700;
          text-transform: uppercase;
          color: #6B7772;
          letter-spacing: 0.03em;
        }

        .cpu-insight-value {
          font-size: 15px;
          font-weight: 700;
          color: #1C2622;
        }

        .cpu-insight-time {
          font-size: 10.5px;
          color: #7A8580;
          margin-left: auto;
        }

        .chart-explanation {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 14px;
          margin-top: 8px;
          padding: 9px 12px;
          background: #F7FAF8;
          border-radius: 7px;
          font-size: 11.5px;
          color: #5F6E68;
        }

        .chart-explanation-item {
          display: flex;
          align-items: center;
          gap: 5px;
        }

        .legend-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          display: inline-block;
        }

        @media (max-width: 900px) {
          .env-impact-grid,
          .forecast-pipeline-grid,
          .two-col-grid {
            grid-template-columns: 1fr;
          }

          .cpu-insight-strip {
            grid-template-columns: 1fr;
          }

          .status-banner,
          .server-title-row {
            flex-direction: column;
            align-items: flex-start;
          }
        }
      `}</style>

      <Link to="/servers" className="back-link">
        ← Return to Server Inventory
      </Link>

      {/* SPEC HEADER */}

      <div className="server-meta-header">
        <div className="server-title-row">
          <div>
            <h1
              className="page-title"
              style={{ margin: "0 0 4px 0" }}
            >
              Server Detail: {id}
            </h1>

            <p
              className="page-subtitle"
              style={{ margin: 0 }}
            >
              Multi-domain hardware profile, live telemetry streams,
              thermal metrics, and near-term workload check.
            </p>
          </div>

          <span
            className={`badge ${
              isIdleFlagged ? "warn" : "good"
            }`}
            style={{
              fontSize: 13,
              padding: "6px 12px",
            }}
          >
            {isIdleFlagged
              ? "Underutilized Node"
              : "Optimal Load"}
          </span>
        </div>

        <div className="spec-badge-group">
          <div className="spec-item">
            <span className="spec-label">Server ID</span>
            <span
              className="spec-value"
              style={{ color: "var(--accent-dark)" }}
            >
              {id}
            </span>
          </div>

          <div className="spec-item">
            <span className="spec-label">Server type</span>
            <span className="spec-value">
              {formatValue(detail?.server_type)}
            </span>
          </div>

          <div className="spec-item">
            <span className="spec-label">Region</span>
            <span className="spec-value">
              {formatValue(detail?.region)}
            </span>
          </div>

          <div className="spec-item">
            <span className="spec-label">Current CPU</span>
            <span className="spec-value">
              {formatValue(latest?.cpu, "%")}
            </span>
          </div>

          <div className="spec-item">
            <span className="spec-label">Current memory</span>
            <span className="spec-value">
              {formatValue(latest?.memory, "%")}
            </span>
          </div>

          <div className="spec-item">
            <span className="spec-label">Network</span>
            <span className="spec-value">
              {formatValue(latest?.network, " Gbps")}
            </span>
          </div>

          <div className="spec-item">
            <span className="spec-label">Cooling type</span>
            <span className="spec-value">
              {formatValue(cooling?.cooling_type)}
            </span>
          </div>

          <div className="spec-item">
            <span className="spec-label">Facility power</span>
            <span className="spec-value">
              {formatValue(
                power?.facility_power_kw,
                " kW"
              )}
            </span>
          </div>
        </div>
      </div>

      {/* STATUS BANNER */}

      <div
        className={`status-banner ${
          isIdleFlagged ? "warn" : "good"
        }`}
      >
        <div>
          <h2 className="banner-title">
            {isIdleFlagged
              ? "Idle server flag active"
              : "System status: normal load"}
          </h2>

          <p className="banner-subtext">
            {isIdleFlagged
              ? `This server's 6-hour average CPU is below its ${formatValue(
                  idleThreshold,
                  "%"
                )} idle threshold for this type — flagged as a consolidation candidate.`
              : idleThreshold !== null
              ? `Operating above this server type's ${idleThreshold}% idle threshold — no waste flag active.`
              : "No idle threshold data yet."}
          </p>
        </div>

        {isIdleFlagged && (
          <button
            type="button"
            className="btn-action-primary"
            onClick={() =>
              navigate("/recommendations")
            }
          >
            Review recommendation →
          </button>
        )}
      </div>

      {/* ================================================================
          1. CPU CHART
          ================================================================ */}

      <div className="section-header">
        <span className="section-title">
          1. CPU utilization history vs. idle threshold
        </span>
      </div>

      <div
        className="card"
        style={{
          padding: 20,
          marginBottom: 24,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <div>
            <h3
              className="card-title"
              style={{ margin: "0 0 4px 0" }}
            >
              Historical utilization trend
            </h3>

            <p
              className="card-subtitle"
              style={{ margin: 0 }}
            >
              {idleThreshold !== null
                ? "Shaded region is this server's own idle threshold zone — not a generic cutoff."
                : "Actual telemetry for this server."}
            </p>
          </div>

          <div className="chart-filter">
            <select
              value={cpuHours}
              onChange={(e) =>
                setCpuHours(Number(e.target.value))
              }
            >
              <option value={1}>Last 1 hour</option>
              <option value={6}>Last 6 hours</option>
              <option value={24}>Last 24 hours</option>
            </select>
          </div>
        </div>

        {/* CPU SUMMARY */}

        {cpuData.length > 0 && (
          <div className="cpu-insight-strip">
            <div className="cpu-insight">
              <span
                className="cpu-insight-dot"
                style={{ background: "#D64545" }}
              />

              <div>
                <div className="cpu-insight-label">
                  Highest
                </div>

                <div className="cpu-insight-value">
                  {cpuStats.highest
                    ? `${Number(
                        cpuStats.highest.cpu
                      ).toFixed(1)}%`
                    : "—"}
                </div>
              </div>

              {cpuStats.highest?.time && (
                <span className="cpu-insight-time">
                  {cpuStats.highest.time}
                </span>
              )}
            </div>

            <div className="cpu-insight">
              <span
                className="cpu-insight-dot"
                style={{ background: "#1D9E75" }}
              />

              <div>
                <div className="cpu-insight-label">
                  Lowest
                </div>

                <div className="cpu-insight-value">
                  {cpuStats.lowest
                    ? `${Number(
                        cpuStats.lowest.cpu
                      ).toFixed(1)}%`
                    : "—"}
                </div>
              </div>

              {cpuStats.lowest?.time && (
                <span className="cpu-insight-time">
                  {cpuStats.lowest.time}
                </span>
              )}
            </div>

            <div className="cpu-insight">
              <span
                className="cpu-insight-dot"
                style={{ background: "#2563EB" }}
              />

              <div>
                <div className="cpu-insight-label">
                  Current
                </div>

                <div className="cpu-insight-value">
                  {latestCpu !== null
                    ? `${latestCpu.toFixed(1)}%`
                    : "—"}
                </div>
              </div>
            </div>
          </div>
        )}

        {loading && rawHistory.length === 0 ? (
          <div className="empty-state">
            Loading telemetry history...
          </div>
        ) : cpuData.length === 0 ? (
          <div className="empty-state">
            No history found for this timeframe.
          </div>
        ) : (
          <>
            <ResponsiveContainer
              width="100%"
              height={280}
            >
              <AreaChart data={forecastChart}>
                <defs>
                  <linearGradient
                    id="detailCpuFill"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="0%"
                      stopColor="#1D9E75"
                      stopOpacity={0.85}
                    />

                    <stop
                      offset="100%"
                      stopColor="#1D9E75"
                      stopOpacity={0.25}
                    />
                  </linearGradient>
                </defs>

                <CartesianGrid
                  stroke="#C8DED5"
                  strokeDasharray="3 3"
                  vertical={false}
                />

                <XAxis
                  dataKey="time"
                  fontSize={12}
                  stroke="#1C2622"
                  tickLine={false}
                  tickFormatter={dedupedTickFormatter(
                    forecastChart
                  )}
                />

                <YAxis
                  fontSize={12}
                  stroke="#1C2622"
                  tickLine={false}
                  unit="%"
                  domain={[0, 100]}
                />

                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) {
                      return null;
                    }

                    const point = payload.find(
                      (p) => p.dataKey === "cpu"
                    )?.payload;

                    if (!point) return null;

                    return (
                      <div
                        style={{
                          background: "#FFFFFF",
                          border: "1px solid #C8DED5",
                          borderRadius: 8,
                          padding: "10px 12px",
                          boxShadow:
                            "0 2px 8px rgba(4,52,44,0.12)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            color: "#6B7772",
                            marginBottom: 4,
                          }}
                        >
                          {label}
                        </div>

                        <div
                          style={{
                            fontSize: 14,
                            fontWeight: 700,
                            color: "#1C2622",
                          }}
                        >
                          CPU:{" "}
                          {Number(point.cpu).toFixed(1)}%
                        </div>

                        {point.peak !== null &&
                          point.peak !== undefined && (
                            <div
                              style={{
                                fontSize: 11.5,
                                color: "#D64545",
                                fontWeight: 700,
                                marginTop: 4,
                              }}
                            >
                              ● Highest CPU point
                            </div>
                          )}

                        {point.lowest !== null &&
                          point.lowest !== undefined && (
                            <div
                              style={{
                                fontSize: 11.5,
                                color: "#1D9E75",
                                fontWeight: 700,
                                marginTop: 4,
                              }}
                            >
                              ● Lowest CPU point
                            </div>
                          )}

                        {point.current !== null &&
                          point.current !== undefined && (
                            <div
                              style={{
                                fontSize: 11.5,
                                color: "#2563EB",
                                fontWeight: 700,
                                marginTop: 4,
                              }}
                            >
                              ● Current reading
                            </div>
                          )}

                        {point.forecast && (
                          <div
                            style={{
                              fontSize: 11.5,
                              color: "#7C3AED",
                              fontWeight: 700,
                              marginTop: 4,
                            }}
                          >
                            ◆ Forecast
                          </div>
                        )}
                      </div>
                    );
                  }}
                />

                <Legend
                  verticalAlign="top"
                  height={36}
                />

                {idleThreshold !== null && (
                  <>
                    <ReferenceArea
                      y1={0}
                      y2={idleThreshold}
                      fill="#FFEAD2"
                      fillOpacity={0.8}
                      label={{
                        value: "Idle zone",
                        position: "insideBottomLeft",
                        fill: "#D9822B",
                        fontSize: 11,
                        fontWeight: 700,
                      }}
                    />

                    <ReferenceLine
                      y={idleThreshold}
                      stroke="#D9822B"
                      strokeWidth={2}
                      strokeDasharray="4 4"
                      label={{
                        value: `${idleThreshold}% threshold`,
                        position: "top",
                        fill: "#D9822B",
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    />
                  </>
                )}

                {/* MAIN CPU TREND */}

                <Area
                  type="monotone"
                  dataKey="cpu"
                  stroke="#0F6E56"
                  strokeWidth={3}
                  fill="url(#detailCpuFill)"
                  name="CPU utilization (%)"
                  dot={false}
                  activeDot={{
                    r: 5,
                    stroke: "#0F6E56",
                    strokeWidth: 2,
                    fill: "#FFFFFF",
                  }}
                />

                {/* HIGHEST POINT */}

                <Area
                  type="monotone"
                  dataKey="peak"
                  stroke="none"
                  fill="none"
                  name="Highest"
                  dot={{
                    r: 6,
                    fill: "#D64545",
                    stroke: "#FFFFFF",
                    strokeWidth: 2,
                  }}
                  activeDot={false}
                  isAnimationActive={false}
                />

                {/* LOWEST POINT */}

                <Area
                  type="monotone"
                  dataKey="lowest"
                  stroke="none"
                  fill="none"
                  name="Lowest"
                  dot={{
                    r: 6,
                    fill: "#1D9E75",
                    stroke: "#FFFFFF",
                    strokeWidth: 2,
                  }}
                  activeDot={false}
                  isAnimationActive={false}
                />

                {/* CURRENT POINT */}

                <Area
                  type="monotone"
                  dataKey="current"
                  stroke="none"
                  fill="none"
                  name="Current"
                  dot={{
                    r: 6,
                    fill: "#2563EB",
                    stroke: "#FFFFFF",
                    strokeWidth: 2,
                  }}
                  activeDot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>

            {/* GRAPH EXPLANATION */}

            <div className="chart-explanation">
              <span
                style={{
                  fontWeight: 700,
                  color: "#39443F",
                }}
              >
                How to read:
              </span>

              <span className="chart-explanation-item">
                <span
                  className="legend-dot"
                  style={{ background: "#D64545" }}
                />
                Red = highest load
              </span>

              <span className="chart-explanation-item">
                <span
                  className="legend-dot"
                  style={{ background: "#1D9E75" }}
                />
                Green = lowest load
              </span>

              <span className="chart-explanation-item">
                <span
                  className="legend-dot"
                  style={{ background: "#2563EB" }}
                />
                Blue = current load
              </span>

              {idleThreshold !== null && (
                <span className="chart-explanation-item">
                  <span
                    style={{
                      width: 18,
                      height: 2,
                      background: "#D9822B",
                      display: "inline-block",
                      borderTop:
                        "2px dashed #D9822B",
                    }}
                  />
                  Orange = idle threshold
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* 2. ENVIRONMENTAL */}

      <div className="section-header">
        <span className="section-title">
          2. Environmental impact right now
        </span>
      </div>

      <div className="env-impact-grid">
        <div className="env-card">
          <div className="env-label">
            Facility power
          </div>

          <div className="env-value">
            {formatValue(
              facilityPowerKw,
              " kW"
            )}
          </div>

          <div className="env-subtext">
            Live reading — the basis for the two
            estimates below
          </div>
        </div>

        <div className="env-card">
          <div className="env-label">
            Carbon rate
          </div>

          <div className="env-value">
            {formatValue(
              hourlyCarbonKg,
              " kg/hr"
            )}
          </div>

          <div className="env-subtext">
            At {emissionFactor ?? "—"} kg CO₂/kWh grid factor, if
            sustained for an hour
          </div>
        </div>

        <div className="env-card">
          <div className="env-label">
            Water rate
          </div>

          <div className="env-value">
            {formatValue(
              hourlyWaterLiters,
              " L/hr"
            )}
          </div>

          <div className="env-subtext">
            {cooling?.cooling_type
              ? `${cooling.cooling_type} cooling, ${waterFactor} L/kWh — this server's own factor, not a fleet average`
              : "Cooling type unknown for this server"}
          </div>
        </div>
      </div>

      {/* 3. FORECAST PIPELINE */}

      <div className="section-header">
        <span className="section-title">
          3. Near-term workload forecast check
        </span>
      </div>

      <div className="forecast-card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <h3
              className="card-title"
              style={{
                margin: "0 0 2px 0",
                fontSize: 17,
              }}
            >
              Workload projection
            </h3>

            <p
              className="card-subtitle"
              style={{ margin: 0 }}
            >
              Verifies whether low CPU usage is expected
              to persist over the selected horizon.
            </p>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--text-secondary)",
              }}
            >
              Horizon:
            </span>

            <select
              value={horizon}
              onChange={(e) =>
                setHorizon(Number(e.target.value))
              }
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid #C8DED5",
                fontSize: 12.5,
                background: "#FFFFFF",
              }}
            >
              <option value={60}>
                Next 1 hour
              </option>

              <option value={360}>
                Next 6 hours
              </option>

              <option value={1440}>
                Next 24 hours
              </option>
            </select>
          </div>
        </div>

        {forecast?.eligible && forecast?.predicted_cpu !== null ? (
          <div className="forecast-pipeline-grid">
            <div className="pipeline-card">
              <div>
                <div className="pipeline-tag">
                  Current vs. predicted
                </div>

                <div className="pipeline-main-val">
                  {forecast.measured_cpu}% →{" "}
                  <span
                    style={{
                      color: "var(--accent-dark)",
                    }}
                  >
                    {forecast.predicted_cpu}%
                  </span>
                </div>

                <div className="pipeline-desc">
                  Measured live vs. predicted load,{" "}
                  <strong>
                    +{formatHorizon(horizon)}
                  </strong>
                  {forecast.method === "historical_average" && (
                    <>
                      {" "}(average over the last{" "}
                      {forecast.lookback_hours_used}h of
                      data — this horizon has no trained
                      model yet)
                    </>
                  )}
                  .
                </div>
              </div>
            </div>

            <div className="pipeline-card">
              <div>
                <div className="pipeline-tag">
                  Change
                </div>

                <div className="pipeline-main-val">
                  {diffString}
                </div>

                <div className="pipeline-desc">
                  Expected change relative to current
                  load.
                </div>
              </div>
            </div>

            <div
              className="pipeline-card"
              style={{
                background: consolidateImpact?.safe
                  ? "#F0F7F4"
                  : "#FBEAE0",
              }}
            >
              <div>
                <div className="pipeline-tag">
                  Consolidation target
                </div>

                {consolidateImpact === null ? (
                  <>
                    <div
                      className="pipeline-main-val"
                      style={{ fontSize: 16 }}
                    >
                      Not yet evaluated
                    </div>

                    <div className="pipeline-desc">
                      No consolidate recommendation
                      exists for this server right now.
                    </div>
                  </>
                ) : consolidateImpact.safe ? (
                  <>
                    <div
                      className="pipeline-main-val"
                      style={{
                        color:
                          "var(--accent-dark)",
                        fontSize: 18,
                      }}
                    >
                      Safe target:{" "}
                      {
                        consolidateImpact.target_server_id
                      }
                    </div>

                    <div className="pipeline-desc">
                      Moving this workload there leaves
                      it at{" "}
                      {
                        consolidateImpact.post_move_cpu
                      }
                      % CPU — under the safety limit.
                    </div>
                  </>
                ) : (
                  <>
                    <div
                      className="pipeline-main-val"
                      style={{
                        color:
                          "var(--danger-text)",
                        fontSize: 18,
                      }}
                    >
                      No safe target found
                    </div>

                    <div className="pipeline-desc">
                      {consolidateImpact
                        .assumptions?.[0] ||
                        "No same-type server currently has headroom."}
                    </div>
                  </>
                )}
              </div>

              <button
                type="button"
                className="btn-action-primary"
                style={{
                  marginTop: 10,
                  padding: "8px 12px",
                  fontSize: 12,
                  width: "100%",
                }}
                onClick={() =>
                  navigate("/recommendations")
                }
              >
                Review in Recommendations →
              </button>
            </div>
          </div>
        ) : forecast?.eligible ? (
          <div
            className="empty-state"
            style={{
              padding: "1.5rem",
              marginTop: 14,
            }}
          >
            Not enough history yet for a{" "}
            {formatHorizon(horizon)} forecast —{" "}
            {formatValue(forecast?.lookback_hours_used, "h")}{" "}
            of data available so far for this server. Try
            a shorter horizon, or check back once more
            telemetry has accumulated.
          </div>
        ) : (
          <div
            className="empty-state"
            style={{
              padding: "1.5rem",
              marginTop: 14,
            }}
          >
            {forecast?.reason ||
              `Server sits above its idle threshold — forecasting only runs for idle/underutilized servers.`}
          </div>
        )}
      </div>

      {/* 4. STORAGE */}

      <div className="section-header">
        <span className="section-title">
          4. Storage breakdown
        </span>
      </div>

      <div
        className="card"
        style={{
          padding: 20,
          marginBottom: 24,
        }}
      >
        {!storage ? (
          <div className="empty-state">
            No storage telemetry for this server.
          </div>
        ) : (
          <ResponsiveContainer
            width="100%"
            height={180}
          >
            <BarChart
              data={storageBreakdownData}
              layout="vertical"
              margin={{
                left: 10,
                right: 30,
              }}
            >
              <CartesianGrid
                stroke="#C8DED5"
                horizontal={false}
              />

              <XAxis
                type="number"
                unit=" GB"
                fontSize={11}
                stroke="#1C2622"
              />

              <YAxis
                dataKey="category"
                type="category"
                fontSize={12}
                stroke="#1C2622"
                width={120}
              />

              <Tooltip
                formatter={(val) => [
                  `${val} GB`,
                  "Capacity",
                ]}
              />

              <Bar
                dataKey="value"
                radius={[0, 4, 4, 0]}
              >
                {storageBreakdownData.map(
                  (entry, idx) => (
                    <Cell
                      key={idx}
                      fill={entry.fill}
                    />
                  )
                )}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* 5. ACTIVE FLAGS */}

      <div className="section-header">
        <span className="section-title">
          5. Active flags for this server
        </span>
      </div>

      <div className="card">
        {flags.length === 0 ? (
          <div className="empty-state">
            No active flags for {id} right now.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Flag</th>
                <th>Severity</th>
                <th>Detail</th>
                <th style={{ textAlign: "right" }}>
                  Value
                </th>
              </tr>
            </thead>

            <tbody>
              {flags.map((f, i) => (
                <tr key={i}>
                  <td className="row-title">
                    {flagLabel(f.flag_type)}
                  </td>

                  <td>
                    <span
                      className={`badge ${f.severity}`}
                    >
                      {f.severity}
                    </span>
                  </td>

                  <td style={{ maxWidth: 380 }}>
                    {f.detail}
                  </td>

                  <td
                    style={{
                      textAlign: "right",
                      fontWeight: 600,
                    }}
                  >
                    {f.metric_value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}