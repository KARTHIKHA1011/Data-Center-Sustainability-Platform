import React, { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  CartesianGrid,
  LabelList,
} from "recharts";
import api from "../api";

/* ==========================================================================
   1. UTILITY FUNCTIONS & HELPERS
   ========================================================================== */

const TYPE_COLORS = {
  Compute: "#1D9E75",
  Edge: "#2F9C95",
  GPU: "#0F6E56",
  Storage: "#1D6F9E",
};

function formatPercent(val) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return "—";
  return `${Number(val).toFixed(1)}%`;
}

function formatNetwork(val) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return "—";
  return `${Number(val).toFixed(2)} Gbps`;
}

/* ==========================================================================
   2. MAIN PAGE COMPONENT
   ========================================================================== */

export default function Servers() {
  const navigate = useNavigate();
  const [servers, setServers] = useState([]);
  const [thresholds, setThresholds] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filter States
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedType, setSelectedType] = useState("all");
  const [selectedRegion, setSelectedRegion] = useState("all");
  const [selectedStatus, setSelectedStatus] = useState("all");

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        const [svRes, thRes] = await Promise.all([
          api.servers(),
          api.thresholds(),
        ]);
        setServers(svRes.data || []);
        setThresholds(thRes.data || {});
        setError(null);
      } catch (err) {
        setError("Failed to load server infrastructure telemetry.");
      } finally {
        setLoading(false);
      }
    };

    loadData();
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, []);

  // Format threshold data for the BarChart with explicit values
  const thresholdChartData = Object.entries(thresholds)
    .filter(([key]) => key !== "_default")
    .map(([type, info]) => ({
      type,
      threshold: info.idle_cpu_threshold,
      severityWeight: info.severity_weight,
    }));

  // Unique Filter Options
  const regions = useMemo(() => {
    const set = new Set(servers.map((s) => s.region).filter(Boolean));
    return Array.from(set);
  }, [servers]);

  const serverTypes = useMemo(() => {
    const set = new Set(servers.map((s) => s.server_type).filter(Boolean));
    return Array.from(set);
  }, [servers]);

  // Filter Logic
  const filteredServers = useMemo(() => {
    return servers.filter((s) => {
      const matchesSearch =
        searchQuery === "" ||
        s.server_id.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesType =
        selectedType === "all" || s.server_type === selectedType;
      const matchesRegion =
        selectedRegion === "all" || s.region === selectedRegion;
      const matchesStatus =
        selectedStatus === "all" ||
        (s.state && s.state.toLowerCase() === selectedStatus.toLowerCase());

      return matchesSearch && matchesType && matchesRegion && matchesStatus;
    });
  }, [servers, searchQuery, selectedType, selectedRegion, selectedStatus]);

  const handleRowClick = (serverId) => {
    navigate(`/servers/${serverId}`);
  };

  const handleResetFilters = () => {
    setSearchQuery("");
    setSelectedType("all");
    setSelectedRegion("all");
    setSelectedStatus("all");
  };

  return (
    <>
      <style>{`
        .servers-container {
          max-width: 1240px;
          margin: 0 auto;
          padding: 8px 0 32px 0;
        }

        .page-header-row {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
          margin-bottom: 20px;
        }

        .inventory-card {
          background: #FFFFFF;
          border: 1px solid var(--border, #E3ECE8);
          border-radius: 12px;
          padding: 22px;
          margin-bottom: 24px;
          box-shadow: 0 1px 3px rgba(4, 52, 44, 0.04);
        }

        .threshold-chart-card {
          background: #FFFFFF;
          border: 1px solid var(--border, #E3ECE8);
          border-radius: 12px;
          padding: 22px;
          box-shadow: 0 1px 3px rgba(4, 52, 44, 0.04);
        }

        /* FILTER CONTROL BAR STYLING */
        .filter-control-bar {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 12px;
          background: #F4F8F6;
          border: 1px solid #DCEFE7;
          border-radius: 10px;
          padding: 12px 16px;
          margin-bottom: 18px;
        }

        .filter-group {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .filter-label {
          font-size: 12.5px;
          font-weight: 600;
          color: var(--text-secondary, #5F6E68);
        }

        .filter-input,
        .filter-select {
          padding: 7px 12px;
          font-size: 13px;
          border: 1px solid #C8DED5;
          border-radius: 6px;
          background: #FFFFFF;
          color: var(--text-primary, #1C2622);
          outline: none;
          transition: border-color 0.15s ease;
        }

        .filter-input:focus,
        .filter-select:focus {
          border-color: var(--accent-dark, #0F6E56);
        }

        .reset-filter-btn {
          padding: 7px 12px;
          font-size: 12.5px;
          font-weight: 600;
          color: var(--accent-dark, #0F6E56);
          background: #FFFFFF;
          border: 1px solid #BCD8CC;
          border-radius: 6px;
          cursor: pointer;
          margin-left: auto;
          transition: all 0.15s ease;
        }

        .reset-filter-btn:hover {
          background: var(--page-bg, #F2F8F5);
        }

        /* PROMINENT VISIBLE GRID TABLE STYLING */
        .grid-data-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 14px;
          border: 1.5px solid #C8DED5;
          margin-top: 8px;
        }

        .grid-data-table th,
        .grid-data-table td {
          padding: 13px 16px;
          border: 1px solid #C8DED5;
          text-align: left;
        }

        .grid-data-table th {
          background: #EBF4F0;
          color: var(--text-primary, #1C2622);
          font-weight: 700;
          font-size: 13px;
          letter-spacing: 0.03em;
        }

        .sno-cell {
          width: 50px;
          text-align: center;
          font-weight: 600;
          color: var(--text-muted, #8A9691);
          background: #FAFCFB;
        }

        /* Interactive Full-Row Clickability */
        .clickable-row {
          cursor: pointer;
          transition: background-color 0.15s ease-in-out;
        }

        .clickable-row:hover {
          background-color: #F0F7F4 !important;
        }

        .server-id-cell {
          font-weight: 700;
          color: var(--accent-dark, #0F6E56);
          font-size: 14.5px;
        }

        .delta-tag {
          font-size: 12px;
          margin-left: 6px;
          font-weight: 600;
        }

        .delta-tag.warn {
          color: var(--warn-text, #D9822B);
        }

        .delta-tag.good {
          color: var(--accent-dark, #0F6E56);
        }

        @media (max-width: 768px) {
          .page-header-row,
          .filter-control-bar {
            flex-direction: column;
            align-items: flex-start;
          }

          .reset-filter-btn {
            margin-left: 0;
            width: 100%;
          }
        }
      `}</style>

      <div className="servers-container">
        {/* HEADER */}
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Server Inventory</h1>
            <p className="page-subtitle">
              Live multi-domain telemetry across compute, edge, GPU, and storage infrastructure.
            </p>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {/* 1. SERVER INVENTORY GRID TABLE (FIRST) */}
        <div className="inventory-card">
          <div style={{ marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div>
              <h3 className="card-title" style={{ margin: "0 0 4px 0", fontSize: 18 }}>
                Active Server Inventory ({filteredServers.length} of {servers.length})
              </h3>
              <p className="card-subtitle" style={{ margin: 0, fontSize: 13.5 }}>
                Click anywhere on a server row to open its detailed multi-domain telemetry dashboard.
              </p>
            </div>
          </div>

          {/* INTERACTIVE FILTER CONTROL BAR */}
          <div className="filter-control-bar">
            <div className="filter-group">
              <span className="filter-label">Search:</span>
              <input
                type="text"
                placeholder="Search Server ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="filter-input"
                style={{ width: 160 }}
              />
            </div>

            <div className="filter-group">
              <span className="filter-label">Type:</span>
              <select
                value={selectedType}
                onChange={(e) => setSelectedType(e.target.value)}
                className="filter-select"
              >
                <option value="all">All Types</option>
                {serverTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <span className="filter-label">Region:</span>
              <select
                value={selectedRegion}
                onChange={(e) => setSelectedRegion(e.target.value)}
                className="filter-select"
              >
                <option value="all">All Regions</option>
                {regions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <span className="filter-label">Status:</span>
              <select
                value={selectedStatus}
                onChange={(e) => setSelectedStatus(e.target.value)}
                className="filter-select"
              >
                <option value="all">All Statuses</option>
                <option value="healthy">Healthy</option>
                <option value="underutilized">Underutilized</option>
                <option value="stale">Stale</option>
                <option value="no data">No Data</option>
              </select>
            </div>

            {(searchQuery || selectedType !== "all" || selectedRegion !== "all" || selectedStatus !== "all") && (
              <button
                type="button"
                className="reset-filter-btn"
                onClick={handleResetFilters}
              >
                Clear Filters
              </button>
            )}
          </div>

          {loading && servers.length === 0 ? (
            <div className="empty-state">Loading server inventory...</div>
          ) : filteredServers.length === 0 ? (
            <div className="empty-state">
              No servers match the active filter criteria.
            </div>
          ) : (
            <table className="grid-data-table">
              <thead>
                <tr>
                  <th style={{ textAlign: "center", width: "60px" }}>S.NO</th>
                  <th>SERVER ID</th>
                  <th>TYPE</th>
                  <th>REGION</th>
                  <th>CPU</th>
                  <th>MEMORY</th>
                  <th>NETWORK</th>
                  <th>6H AVG CPU</th>
                  <th style={{ textAlign: "right" }}>STATUS</th>
                </tr>
              </thead>
              <tbody>
                {filteredServers.map((s, index) => {
                  const t = thresholds[s.server_type];
                  const thresholdVal = t ? t.idle_cpu_threshold : 20;
                  const avgCpu = s.avg_cpu ?? s.cpu;
                  const isUnder = t && avgCpu != null && avgCpu < thresholdVal;
                  const diff = t && avgCpu != null ? (avgCpu - thresholdVal).toFixed(1) : null;

                  return (
                    <tr
                      key={s.server_id}
                      className="clickable-row"
                      onClick={() => handleRowClick(s.server_id)}
                    >
                      <td className="sno-cell">{index + 1}</td>
                      <td className="server-id-cell">{s.server_id}</td>
                      <td>{s.server_type}</td>
                      <td style={{ color: "var(--text-secondary)" }}>{s.region || "—"}</td>
                      <td><strong>{formatPercent(s.cpu)}</strong></td>
                      <td>{formatPercent(s.memory)}</td>
                      <td>{formatNetwork(s.network_gbps)}</td>
                      <td>
                        {formatPercent(avgCpu)}
                        {diff !== null && (
                          <span className={`delta-tag ${isUnder ? "warn" : "good"}`}>
                            ({diff > 0 ? `+${diff}` : diff}%)
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <span className={`badge ${s.state ? s.state.toLowerCase().replace(" ", "") : "neutral"}`}>
                          {s.state || "Active"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* 2. HARDWARE IDLE THRESHOLDS BAR CHART (SECOND) */}
        <div className="threshold-chart-card">
          <div style={{ marginBottom: 16 }}>
            <h3 className="card-title" style={{ margin: "0 0 4px 0", fontSize: 18 }}>
              Hardware Idle Thresholds (% CPU)
            </h3>
            <p className="card-subtitle" style={{ margin: 0, fontSize: 13.5 }}>
              Per-server-type CPU utilization baselines derived from dataset statistics (`mean − 1.5×std`).
            </p>
          </div>

          {thresholdChartData.length === 0 ? (
            <div className="empty-state">Loading hardware baselines...</div>
          ) : (
            <ResponsiveContainer width="100%" height={210}>
              <BarChart
                data={thresholdChartData}
                margin={{ top: 25, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid stroke="#E3ECE8" vertical={false} />
                <XAxis
                  dataKey="type"
                  fontSize={13}
                  stroke="#1C2622"
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  fontSize={13}
                  stroke="#1C2622"
                  tickLine={false}
                  axisLine={false}
                  unit="%"
                  domain={[0, 25]}
                />
                <Tooltip
                  formatter={(value, name) => [
                    `${value}%`,
                    name === "threshold" ? "Idle Threshold Cutoff" : name,
                  ]}
                />
                <Bar
                  dataKey="threshold"
                  radius={[4, 4, 0, 0]}
                  name="Idle Threshold"
                >
                  {/* EXPLICIT VALUE LABELS ON TOP OF EACH BAR */}
                  <LabelList
                    dataKey="threshold"
                    position="top"
                    formatter={(val) => `${val}%`}
                    style={{ fill: "#1C2622", fontWeight: 700, fontSize: "13px" }}
                  />
                  {thresholdChartData.map((entry) => (
                    <Cell
                      key={entry.type}
                      fill={TYPE_COLORS[entry.type] || "var(--accent)"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </>
  );
}