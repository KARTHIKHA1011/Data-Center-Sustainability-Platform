import React, { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
  LabelList,
} from "recharts";
import api from "../api";

const FLAG_META = {
  stale_data: {
    label: "Stale Data",
    color: "#EF9F27",
    plain: "Inactive for >90 days on active storage volumes.",
  },
  duplicate_data: {
    label: "Duplicate Data",
    color: "#1D9E75",
    plain: ">20% duplicate file copies detected.",
  },
  overprovisioned: {
    label: "Over-Provisioned",
    color: "#0F6E56",
    plain: "<30% allocated space in active use.",
  },
};

function StorageTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div
      style={{
        background: "#FFFFFF",
        border: "1px solid var(--border, #E3ECE8)",
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 12.5,
        boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
      }}
    >
      <strong>{d.label}</strong>
      <div style={{ color: "var(--text-secondary)", marginTop: 2 }}>
        {d.gb} GB flagged across {d.count} volume(s)
      </div>
    </div>
  );
}

export default function Storage() {
  const [flags, setFlags] = useState([]);
  const [summary, setSummary] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const [f, s] = await Promise.all([
          api.storageFlags(),
          api.analyticsSummary(),
        ]);
        if (!mounted) return;
        setFlags(Array.isArray(f.data) ? f.data : f.data?.flags || []);
        setSummary(s.data);
      } catch (err) {
        if (mounted) setFlags([]);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    load();
    const interval = setInterval(load, 15000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Calculate waste distribution per flag category
  const composition = useMemo(() => {
    return Object.entries(FLAG_META).map(([type, meta]) => {
      const rows = flags.filter((f) => f.flag_type === type);
      const gb = rows.reduce((sum, r) => sum + (r.metric_value_gb || 0), 0);
      return {
        type,
        label: meta.label,
        color: meta.color,
        gb: Math.round(gb * 10) / 10,
        count: rows.length,
      };
    });
  }, [flags]);

  const wastedGb = useMemo(() => {
    return composition.reduce((sum, c) => sum + c.gb, 0);
  }, [composition]);

  const wastedShare = useMemo(() => {
    if (!summary?.total_storage_gb || summary.total_storage_gb === 0) return 0;
    return Math.round((wastedGb / summary.total_storage_gb) * 100);
  }, [summary, wastedGb]);

  // Filter volume rows based on category pills and search query
  const filteredFlags = useMemo(() => {
    return flags.filter((f) => {
      const matchesCat =
        selectedCategory === "all" || f.flag_type === selectedCategory;
      const matchesSearch =
        !searchQuery ||
        f.server_id?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        f.detail?.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCat && matchesSearch;
    });
  }, [flags, selectedCategory, searchQuery]);

  return (
    <div style={{ maxWidth: 1240, margin: "0 auto", paddingBottom: 32 }}>
      <style>{`
        .section-header-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .provenance-tag {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.05em;
          padding: 3px 8px;
          border-radius: 4px;
          background: #E8F2EE;
          color: #0F6E56;
          text-transform: uppercase;
        }

        .filter-pill {
          padding: 6px 14px;
          border-radius: 20px;
          font-size: 12.5px;
          font-weight: 600;
          border: 1px solid var(--border, #E3ECE8);
          background: #FFFFFF;
          color: var(--text-secondary, #5F6E68);
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .filter-pill:hover {
          border-color: var(--accent-dark, #0F6E56);
          color: var(--accent-dark, #0F6E56);
        }

        .filter-pill.active {
          background: var(--accent-dark, #0F6E56);
          color: #FFFFFF;
          border-color: var(--accent-dark, #0F6E56);
        }

        .search-input {
          padding: 6px 12px;
          border-radius: 6px;
          border: 1px solid var(--border, #E3ECE8);
          font-size: 12.5px;
          width: 220px;
        }

        .volume-table {
          width: 100%;
          border-collapse: collapse;
          background: #FFFFFF;
          border-radius: 10px;
          border: 1px solid var(--border, #E3ECE8);
          overflow: hidden;
        }

        .volume-table th {
          text-align: left;
          padding: 12px 16px;
          font-size: 11.5px;
          font-weight: 700;
          text-transform: uppercase;
          color: var(--text-secondary, #5F6E68);
          background: #F4F8F6;
          border-bottom: 1px solid var(--border, #E3ECE8);
        }

        .volume-table td {
          padding: 12px 16px;
          font-size: 13px;
          border-bottom: 1px solid var(--border, #E3ECE8);
          color: var(--text-primary, #1C2622);
        }

        .volume-table tr:last-child td {
          border-bottom: none;
        }

        .server-link {
          color: var(--accent-dark, #0F6E56);
          font-weight: 600;
          text-decoration: none;
        }

        .server-link:hover {
          text-decoration: underline;
        }
      `}</style>

      {/* HEADER */}
      <div className="page-header" style={{ marginBottom: 20 }}>
        <div>
          <h1 className="page-title">Storage Optimization</h1>
          <p className="page-subtitle">
            Capacity breakdown based on volume metadata, duplication ratios, and access history.
          </p>
        </div>
      </div>

      {/* TOP SUMMARY METRIC CARDS */}
      {summary && (
        <div className="metric-grid" style={{ marginBottom: 24 }}>
          <div className="metric-card">
            <p className="metric-label">Total Allocated Capacity</p>
            <p className="metric-value">{summary.total_storage_gb} GB</p>
            <p className="metric-hint">Across active volume fleet</p>
          </div>

          <div className={`metric-card ${wastedGb > 0 ? "warn" : ""}`}>
            <p className="metric-label">Flagged Waste Capacity</p>
            <p className="metric-value">{wastedGb.toFixed(1)} GB</p>
            <p className="metric-hint">
              {wastedShare > 0 ? `${wastedShare}% of fleet capacity flagged` : "Zero waste flags"}
            </p>
          </div>

          <div className="metric-card">
            <p className="metric-label">Flagged Volumes Count</p>
            <p className="metric-value">{flags.length}</p>
            <p className="metric-hint">Active optimization targets</p>
          </div>
        </div>
      )}

      {/* CHART SECTION */}
      {wastedGb > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div className="section-header-row">
            <span className="section-label" style={{ margin: 0 }}>
              Waste Category Distribution
            </span>
            <span className="provenance-tag">METADATA ENGINE</span>
          </div>

          <div className="card" style={{ padding: 20 }}>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart
                data={composition}
                layout="vertical"
                margin={{ top: 0, right: 50, left: 0, bottom: 0 }}
              >
                <CartesianGrid stroke="#E3ECE8" horizontal={false} />
                <XAxis
                  type="number"
                  fontSize={12}
                  stroke="#5F6E68"
                  tickLine={false}
                  unit=" GB"
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  fontSize={13}
                  stroke="#1C2622"
                  tickLine={false}
                  width={140}
                />
                <Tooltip
                  content={<StorageTooltip />}
                  cursor={{ fill: "rgba(15,110,86,0.04)" }}
                />
                <Bar dataKey="gb" radius={[0, 6, 6, 0]} maxBarSize={28}>
                  {composition.map((c) => (
                    <Cell key={c.type} fill={c.color} />
                  ))}
                  <LabelList
                    dataKey="gb"
                    position="right"
                    formatter={(v) => `${v} GB`}
                    fontSize={12.5}
                    fill="var(--text-secondary, #5F6E68)"
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* FLAGGED VOLUMES SECTION */}
      <div className="section-header-row">
        <span className="section-label" style={{ margin: 0 }}>
          Flagged Volume Inventory ({filteredFlags.length})
        </span>

        <input
          type="text"
          className="search-input"
          placeholder="Filter by server or detail..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* CATEGORY FILTER PILLS */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          className={`filter-pill ${selectedCategory === "all" ? "active" : ""}`}
          onClick={() => setSelectedCategory("all")}
        >
          All Categories ({flags.length})
        </button>
        {Object.entries(FLAG_META).map(([type, meta]) => {
          const count = flags.filter((f) => f.flag_type === type).length;
          return (
            <button
              key={type}
              type="button"
              className={`filter-pill ${selectedCategory === type ? "active" : ""}`}
              onClick={() => setSelectedCategory(type)}
            >
              {meta.label} ({count})
            </button>
          );
        })}
      </div>

      {/* VOLUME TABLE */}
      {loading ? (
        <div className="empty-state">Loading storage telemetry...</div>
      ) : filteredFlags.length === 0 ? (
        <div className="empty-state">No storage issues match criteria.</div>
      ) : (
        <table className="volume-table">
          <thead>
            <tr>
              <th>Target Server</th>
              <th>Flag Category</th>
              <th>Description / Findings</th>
              <th style={{ textAlign: "right" }}>Flagged Volume</th>
            </tr>
          </thead>
          <tbody>
            {filteredFlags.map((f, i) => {
              const meta = FLAG_META[f.flag_type] || {
                label: f.flag_type,
                color: "#5F6E68",
              };
              return (
                <tr key={i}>
                  <td>
                    <Link to={`/servers/${f.server_id}`} className="server-link">
                      {f.server_id}
                    </Link>
                  </td>
                  <td>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "3px 8px",
                        borderRadius: 4,
                        fontSize: 11.5,
                        fontWeight: 700,
                        color: "#FFFFFF",
                        background: meta.color,
                      }}
                    >
                      {meta.label}
                    </span>
                  </td>
                  <td>{f.detail}</td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>
                    {f.metric_value_gb} GB
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}