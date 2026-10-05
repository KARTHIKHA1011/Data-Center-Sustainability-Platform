import { useEffect, useState, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  RadialBarChart, RadialBar, PolarAngleAxis,
  BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
  LineChart, Line, ReferenceLine,
  ResponsiveContainer, CartesianGrid,
} from "recharts";
import api from "../api";
import { useAuth } from "../AuthContext";

/* ─── Helpers ─────────────────────────────────────────────────── */

function typeLabel(type) {
  return { consolidate: "Consolidate workload", rightsize: "Rightsize storage", archive: "Archive stale data", deduplicate: "Deduplicate storage" }[type] || type;
}
function acceptActionFor(type) { return type === "consolidate" ? "consolidate" : "rightsize"; }
function acceptLabelFor(type) {
  return { consolidate: "Consolidate", rightsize: "Rightsize", archive: "Archive", deduplicate: "Deduplicate" }[type] || "Accept";
}
function fmt(v, dp = 2) { return v == null ? "—" : Number(v).toFixed(dp); }

/* ─── CPU history line chart ──────────────────────────────────── */

function CpuHistoryChart({ serverId, serverType }) {
  const [history,   setHistory]   = useState([]);
  const [threshold, setThreshold] = useState(null);
  const [loading,   setLoading]   = useState(true);

  useEffect(() => {
    if (!serverId) return;
    (async () => {
      try {
        setLoading(true);
        const [histRes, thRes] = await Promise.all([
          api.serverHistory(serverId, 6),
          api.thresholds(),
        ]);
        const raw = histRes.data || [];

        // Downsample to ≤80 points so the chart stays readable
        const step = Math.max(1, Math.floor(raw.length / 80));
        const pts  = raw
          .filter((_, i) => i % step === 0)
          .map(r => ({
            t:   new Date(r.timestamp.endsWith("Z") ? r.timestamp : `${r.timestamp}Z`).getTime(),
            cpu: parseFloat(r.cpu.toFixed(1)),
          }));

        setHistory(pts);
        const th = thRes.data || {};
        const t  = th[serverType]?.idle_cpu_threshold ?? th["_default"]?.idle_cpu_threshold ?? 20;
        setThreshold(t);
      } catch {
        // leave empty — chart just won't show
      } finally {
        setLoading(false);
      }
    })();
  }, [serverId, serverType]);

  if (loading) return (
    <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading telemetry…</span>
    </div>
  );
  if (!history.length) return null;

  const avgCpu  = history.reduce((s, p) => s + p.cpu, 0) / history.length;
  const maxCpu  = Math.max(...history.map(p => p.cpu));
  const yDomain = [0, Math.max(threshold ? threshold * 1.6 : 30, maxCpu * 1.2, 25)];

  // Format timestamp tick: show HH:MM
  const tickFormatter = (t) => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <div className="rd-telemetry-chart">
      <div className="rd-telemetry-chart-header">
        <div>
          <span className="rd-telemetry-chart-title">CPU utilisation — last 6 hours</span>
          <span className="rd-telemetry-chart-sub">{serverId} · {history.length} readings sampled</span>
        </div>
        <div className="rd-telemetry-stats">
          <div className="rd-telemetry-stat">
            <span className="rd-telemetry-stat-label">6h avg</span>
            <span className="rd-telemetry-stat-val" style={{ color: "#E24B4A" }}>{avgCpu.toFixed(1)}%</span>
          </div>
          {threshold && (
            <div className="rd-telemetry-stat">
              <span className="rd-telemetry-stat-label">idle threshold</span>
              <span className="rd-telemetry-stat-val">{threshold}%</span>
            </div>
          )}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={history} margin={{ top: 6, right: 16, left: 0, bottom: 4 }}>
          <CartesianGrid stroke="#E3ECE8" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="t" type="number" scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={tickFormatter}
            tick={{ fontSize: 10, fill: "#8A9691" }}
            axisLine={false} tickLine={false}
            interval="preserveStartEnd" tickCount={6}
          />
          <YAxis
            domain={yDomain} tickFormatter={v => `${v}%`}
            tick={{ fontSize: 10, fill: "#8A9691" }}
            axisLine={false} tickLine={false} width={34}
          />
          <Tooltip
            wrapperStyle={{ outline: "none", border: "none", boxShadow: "none" }}
            content={({ payload, label }) => {
              if (!payload?.length) return null;
              return (
                <div style={{ background: "#fff", border: "1px solid #E3ECE8", borderRadius: 7, padding: "7px 11px", fontSize: 12 }}>
                  <div style={{ color: "#8A9691", marginBottom: 3 }}>{tickFormatter(label)}</div>
                  <div><strong style={{ color: "#E24B4A" }}>{payload[0]?.value}%</strong> CPU</div>
                  {threshold && <div style={{ color: "#8A9691", fontSize: 11 }}>threshold: {threshold}%</div>}
                </div>
              );
            }}
          />
          {threshold && (
            <ReferenceLine
              y={threshold} stroke="#D97706" strokeDasharray="5 3" strokeWidth={1.5}
              label={{ value: `Idle threshold ${threshold}%`, position: "insideTopRight", fontSize: 10, fill: "#D97706" }}
            />
          )}
          <Line
            type="monotone" dataKey="cpu" stroke="#E24B4A" strokeWidth={1.5}
            dot={false} activeDot={{ r: 3, fill: "#E24B4A" }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ─── Storage breakdown chart ─────────────────────────────────── */

function StorageBreakdownChart({ serverId, recType }) {
  const [storage, setStorage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!serverId) return;
    (async () => {
      try {
        setLoading(true);
        const res = await api.serverDetail(serverId);
        setStorage(res.data?.storage || null);
      } catch {
        // leave null
      } finally {
        setLoading(false);
      }
    })();
  }, [serverId]);

  if (loading) return (
    <div style={{ height: 110, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading storage data…</span>
    </div>
  );
  if (!storage) return null;

  const { total_storage_gb: total, used_storage_gb: used, duplicate_data_gb: dup, last_accessed_days_ago: days } = storage;
  const clean    = Math.max(0, used - (dup || 0));
  const free     = Math.max(0, total - used);
  const usedPct  = total ? ((used / total) * 100).toFixed(0) : 0;
  const dupPct   = total ? ((dup  / total) * 100).toFixed(0) : 0;

  // Highlight the waste segment based on rec type
  const wasteLabel = recType === "deduplicate" ? "Duplicate data" : recType === "archive" ? "Stale data" : "Over-provisioned";
  const wasteColor = "#E24B4A";

  const barData = [{ name: serverId, clean, duplicate: dup || 0, free }];

  return (
    <div className="rd-telemetry-chart">
      <div className="rd-telemetry-chart-header">
        <div>
          <span className="rd-telemetry-chart-title">Storage allocation breakdown</span>
          <span className="rd-telemetry-chart-sub">{serverId} · {storage.storage_type} · {total.toFixed(0)} GB total</span>
        </div>
        <div className="rd-telemetry-stats">
          <div className="rd-telemetry-stat">
            <span className="rd-telemetry-stat-label">utilised</span>
            <span className="rd-telemetry-stat-val">{usedPct}%</span>
          </div>
          {dup > 0 && (
            <div className="rd-telemetry-stat">
              <span className="rd-telemetry-stat-label">redundant</span>
              <span className="rd-telemetry-stat-val" style={{ color: wasteColor }}>{dupPct}%</span>
            </div>
          )}
          {days != null && (
            <div className="rd-telemetry-stat">
              <span className="rd-telemetry-stat-label">last accessed</span>
              <span className="rd-telemetry-stat-val">{days}d ago</span>
            </div>
          )}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={64}>
        <BarChart data={barData} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
          <XAxis type="number" domain={[0, total]} hide />
          <YAxis type="category" dataKey="name" hide />
          <Tooltip
            wrapperStyle={{ outline: "none", border: "none", boxShadow: "none" }}
            content={({ payload }) => {
              if (!payload?.length) return null;
              return (
                <div style={{ background: "#fff", border: "1px solid #E3ECE8", borderRadius: 7, padding: "8px 12px", fontSize: 12 }}>
                  {payload.map(p => (
                    <div key={p.dataKey} style={{ color: p.fill, marginBottom: 2 }}>
                      <strong>{p.value.toFixed(1)} GB</strong> {p.name}
                    </div>
                  ))}
                </div>
              );
            }}
          />
          <Bar dataKey="clean"     name="Active data"   stackId="s" fill="#1D9E75" radius={[4, 0, 0, 4]} barSize={28} />
          <Bar dataKey="duplicate" name={wasteLabel}    stackId="s" fill={wasteColor} barSize={28} />
          <Bar dataKey="free"      name="Free / unused" stackId="s" fill="#E3ECE8" radius={[0, 4, 4, 0]} barSize={28} />
        </BarChart>
      </ResponsiveContainer>
      {/* legend */}
      <div style={{ display: "flex", gap: 14, marginTop: 8, flexWrap: "wrap" }}>
        {[
          { color: "#1D9E75", label: `Active data (${clean.toFixed(0)} GB)` },
          { color: wasteColor, label: `${wasteLabel} (${(dup || 0).toFixed(0)} GB)` },
          { color: "#C8D8D2", label: `Free (${free.toFixed(0)} GB)` },
        ].map(l => (
          <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-muted)" }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: l.color, flexShrink: 0 }} />
            {l.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/*
 * Re-compute impact metrics when the user selects an alternate target.
 * The backend calculated everything relative to the originally selected
 * (best-ranked) target. We scale proportionally using the ratio of
 * post-move CPU utilisation between the selected and alternate target
 * — the same approach the backend uses (facility_power × cpu_ratio).
 */
function rescaleImpact(baseImpact, originalCandidate, newCandidate) {
  if (!originalCandidate || !newCandidate) return baseImpact;
  const originalCpu = originalCandidate.post_move_cpu;
  const newCpu      = newCandidate.post_move_cpu;
  if (!originalCpu || originalCpu === 0) return baseImpact;

  // A higher post-move CPU on the new target means less headroom freed,
  // so savings scale down proportionally.
  const ratio = originalCpu / newCpu;

  return {
    ...baseImpact,
    target_server_id:           newCandidate.server_id,
    post_move_cpu:              newCandidate.post_move_cpu,
    post_move_memory:           newCandidate.post_move_memory,
    risk_score:                 +(Math.max(newCandidate.post_move_cpu, newCandidate.post_move_memory) / 75).toFixed(2),
    estimated_energy_saving_kwh:    +((baseImpact.estimated_energy_saving_kwh    || 0) * ratio).toFixed(2),
    estimated_carbon_reduction_kg:  +((baseImpact.estimated_carbon_reduction_kg  || 0) * ratio).toFixed(2),
    estimated_cost_saving:          +((baseImpact.estimated_cost_saving          || 0) * ratio).toFixed(2),
    estimated_water_saving_l:       +((baseImpact.estimated_water_saving_l       || 0) * ratio).toFixed(2),
  };
}

/* ─── Risk gauge ──────────────────────────────────────────────── */

function RiskGauge({ score }) {
  if (score == null) return null;
  const pct   = Math.min(Math.round(score * 100), 100);
  const color = score < 0.4 ? "#1D9E75" : score < 0.7 ? "#D97706" : "#E24B4A";
  const label = score < 0.4 ? "Low risk" : score < 0.7 ? "Moderate" : "High risk";

  return (
    <div className="rd-gauge-wrap">
      <p className="rd-visual-heading">Risk score</p>
      <div className="rd-gauge-chart">
        <ResponsiveContainer width={130} height={130}>
          <RadialBarChart cx="50%" cy="50%" innerRadius="68%" outerRadius="100%"
            startAngle={225} endAngle={-45} data={[{ value: pct, fill: color }]}>
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
            <RadialBar dataKey="value" background={{ fill: "#F2F8F5" }} cornerRadius={6} />
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="rd-gauge-label">
          <span className="rd-gauge-value" style={{ color }}>{score.toFixed(2)}</span>
          <span className="rd-gauge-sub">{label}</span>
        </div>
      </div>
      <p className="rd-gauge-hint">0 = no risk · 1 = at limit</p>
    </div>
  );
}

/* ─── Post-move utilisation chart ─────────────────────────────── */

function PostMoveChart({ postCpu, postMemory, targetId }) {
  if (postCpu == null) return null;
  const data = [
    { name: "CPU",    after: parseFloat(postCpu.toFixed(1)) },
    { name: "Memory", after: parseFloat(postMemory.toFixed(1)) },
  ];
  return (
    <div className="rd-chart-wrap">
      <p className="rd-visual-heading">Post-move utilisation</p>
      <p className="rd-chart-sub">{targetId} after consolidation — must stay under 75%.</p>
      <ResponsiveContainer width="100%" height={120}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, left: 16, bottom: 4 }}>
          <CartesianGrid horizontal={false} stroke="#E3ECE8" strokeDasharray="3 3" />
          <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: "#8A9691" }}
            tickFormatter={v => `${v}%`} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="name" width={52}
            tick={{ fontSize: 12, fill: "#5F6E68", fontWeight: 600 }} axisLine={false} tickLine={false} />
          <Tooltip cursor={{ fill: "rgba(4,52,44,.04)" }}
            content={({ payload, label }) => {
              if (!payload?.length) return null;
              return (
                <div style={{ background: "#fff", border: "1px solid #E3ECE8", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
                  <strong>{label}</strong>
                  <div style={{ color: "#0F6E56", marginTop: 3 }}>After: {payload[0]?.value}%</div>
                  <div style={{ color: "#8A9691" }}>Safety limit: 75%</div>
                </div>
              );
            }}
          />
          <Bar dataKey="after" radius={[0, 4, 4, 0]} barSize={16}
            label={{ position: "right", fontSize: 11, fill: "#1C2622", formatter: v => `${v}%` }}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.after < 50 ? "#1D9E75" : d.after < 70 ? "#D97706" : "#E24B4A"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ─── Candidate selector card ─────────────────────────────────── */

function CandidateCard({ c, isSelected, onSelect }) {
  const cpuColor = c.post_move_cpu  < 50 ? "#1D9E75" : c.post_move_cpu  < 70 ? "#D97706" : "#E24B4A";
  const memColor = c.post_move_memory < 50 ? "#1D9E75" : c.post_move_memory < 70 ? "#D97706" : "#E24B4A";

  // Three-way status, not just safe/unsafe: a candidate can look fine RIGHT
  // NOW (safe_now) but be predicted to get busy on its own soon enough to
  // cross the limit anyway (safe_forecast) -- see forecast_candidate_server()
  // on the backend. c.safe is only true when all of CPU/memory (now +
  // forecast), network, and thermal agree.
  const riskySoon = c.safe_now && c.safe_forecast === false;
  const networkOrThermalBlocked = c.network_ok === false || c.thermal_ok === false;
  const statusCls   = c.safe ? "good" : riskySoon ? "warn" : "danger";
  const statusLabel = c.safe
    ? "Safe"
    : riskySoon
    ? "Risky soon"
    : networkOrThermalBlocked
    ? (c.network_ok === false && c.thermal_ok === false
        ? "Network + thermal limit"
        : c.network_ok === false
        ? "Network limit"
        : "Thermal limit")
    : "Over limit";

  const hasForecast = c.forecast_available &&
    c.forecast_predicted_cpu !== null && c.forecast_predicted_cpu !== undefined;

  return (
    <button
      className={`rd-candidate-card ${isSelected ? "selected" : ""}`}
      onClick={() => onSelect(c)}
      aria-pressed={isSelected}
    >
      <div className="rd-candidate-top">
        <span className="rd-candidate-id">{c.server_id}</span>
        <span className={`badge ${statusCls}`} style={{ fontSize: 10.5 }}>
          {statusLabel}
        </span>
      </div>
      <div className="rd-candidate-metrics">
        <div className="rd-candidate-metric">
          <div className="rd-candidate-metric-row">
            <span className="rd-candidate-metric-label">CPU</span>
            <span className="rd-candidate-metric-val" style={{ color: cpuColor }}>{c.post_move_cpu}%</span>
          </div>
          <div className="rd-candidate-bar-track">
            <div className="rd-candidate-bar-fill" style={{ width: `${Math.min(c.post_move_cpu, 100)}%`, background: cpuColor }} />
            <div className="rd-candidate-bar-limit" />
          </div>
        </div>
        <div className="rd-candidate-metric">
          <div className="rd-candidate-metric-row">
            <span className="rd-candidate-metric-label">Memory</span>
            <span className="rd-candidate-metric-val" style={{ color: memColor }}>{c.post_move_memory}%</span>
          </div>
          <div className="rd-candidate-bar-track">
            <div className="rd-candidate-bar-fill" style={{ width: `${Math.min(c.post_move_memory, 100)}%`, background: memColor }} />
            <div className="rd-candidate-bar-limit" />
          </div>
        </div>
      </div>
      {hasForecast && (
        <div className="rd-candidate-forecast" title="This server's own near-term forecast, independent of this move">
          Own forecast: {c.forecast_predicted_cpu.toFixed(1)}% CPU
          {c.forecast_predicted_memory != null && ` / ${c.forecast_predicted_memory.toFixed(1)}% memory`}
          {" "}
        </div>
      )}
      {(c.post_move_network_gbps != null || c.predicted_post_move_temp_c != null) && (
        <div
          className="rd-candidate-forecast"
          title="Post-move network throughput and predicted inlet temperature -- stated conventions (25 Gbps NIC, 30°C ceiling), not measured capacities"
        >
          {c.post_move_network_gbps != null && (
            <span style={{ color: c.network_ok === false ? "#E24B4A" : "inherit" }}>
              {c.network_ok === false ? "⚠ " : ""}Network: {c.post_move_network_gbps.toFixed(1)} Gbps
            </span>
          )}
          {c.post_move_network_gbps != null && c.predicted_post_move_temp_c != null && "  ·  "}
          {c.predicted_post_move_temp_c != null && (
            <span style={{ color: c.thermal_ok === false ? "#E24B4A" : "inherit" }}>
              {c.thermal_ok === false ? "⚠ " : ""}Temp: {c.predicted_post_move_temp_c.toFixed(1)}°C
            </span>
          )}
        </div>
      )}
      {isSelected && <div className="rd-candidate-selected-hint">Currently selected target</div>}
    </button>
  );
}

/* ─── Main ────────────────────────────────────────────────────── */

export default function RecommendationDetail() {
  const { id }   = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [rec,       setRec]       = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState("");
  const [actLoad,   setActLoad]   = useState(false);
  const [decision,  setDecision]  = useState(null); // { action, target, impact } — set after submit

  // Which candidate the user has pinned — null means use the backend's top pick
  const [selectedCandidateId, setSelectedCandidateId] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setError("");
        const r = await api.recommendation(id);
        setRec(r.data);
        setSelectedCandidateId(null); // reset on navigation
      } catch (e) {
        setError(e.response?.data?.detail || "Recommendation not found.");
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const handleAction = async (action, snoozeHours) => {
    try {
      setActLoad(true);
      await api.recommendationAction(
        id,
        action,
        "",
        snoozeHours,
        action === "consolidate" ? selectedCandidateId : null,
      );
      // Capture a decision snapshot to show the confirmation screen
      setDecision({
        action,
        serverId:  rec.server_id,
        target:    effectiveImpact?.target_server_id || null,
        energy:    effectiveImpact?.estimated_energy_saving_kwh    || 0,
        carbon:    effectiveImpact?.estimated_carbon_reduction_kg  || 0,
        cost:      effectiveImpact?.estimated_cost_saving          || 0,
        storage:   effectiveImpact?.estimated_storage_reclaimed_gb || 0,
      });
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to record decision.");
    } finally {
      setActLoad(false);
    }
  };

  // Derive the effective impact based on selected candidate
  const effectiveImpact = useMemo(() => {
    if (!rec) return null;
    const base       = rec.impact || {};
    const candidates = base.candidates || [];

    if (!selectedCandidateId || selectedCandidateId === base.target_server_id) return base;

    const originalCandidate = candidates.find(c => c.server_id === base.target_server_id);
    const newCandidate      = candidates.find(c => c.server_id === selectedCandidateId);
    if (!newCandidate) return base;

    return rescaleImpact(base, originalCandidate, newCandidate);
  }, [rec, selectedCandidateId]);

  if (loading) return (
    <div>
      <Link to="/recommendations" className="rd-back">← Recommendations</Link>
      <div className="empty-state" style={{ marginTop: 16 }}>Loading…</div>
    </div>
  );
  if (!rec) return (
    <div>
      <Link to="/recommendations" className="rd-back">← Recommendations</Link>
      <div className="empty-state" style={{ marginTop: 16 }}>{error || "Not found."}</div>
    </div>
  );

  // ── Decision confirmed — show result screen ──────────────────
  if (decision) {
    const LABELS = {
      consolidate: "Consolidation approved",
      rightsize:   "Right-sizing approved",
      archive:     "Archival approved",
      deduplicate: "Deduplication approved",
      snooze:      "Snoozed for 24 hours",
      do_nothing:  "Recommendation dismissed",
    };
    const isAccepted = ["consolidate", "rightsize", "archive", "deduplicate"].includes(decision.action);
    const isSnoozed  = decision.action === "snooze";
    const hasImpact  = decision.energy > 0 || decision.storage > 0;

    return (
      <>
        <style>{`
          .rd-confirm-page { max-width: 620px; margin: 40px auto; text-align: center; }
          .rd-confirm-icon {
            width: 56px; height: 56px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 24px; margin: 0 auto 16px;
            background: ${isAccepted ? "var(--success-bg,#E1F5EE)" : isSnoozed ? "var(--warn-bg,#FEF3C7)" : "var(--page-bg,#F2F8F5)"};
          }
          .rd-confirm-title {
            font-size: 20px; font-weight: 700; color: var(--text-primary); margin: 0 0 8px;
          }
          .rd-confirm-sub {
            font-size: 14px; color: var(--text-secondary); margin: 0 0 28px; line-height: 1.6;
          }
          .rd-confirm-impact {
            background: #fff; border: 1px solid var(--border,#E3ECE8);
            border-radius: 12px; padding: 20px 24px; margin-bottom: 24px;
            text-align: left;
          }
          .rd-confirm-impact-title {
            font-size: 11px; font-weight: 700; text-transform: uppercase;
            letter-spacing: .06em; color: var(--text-muted); margin: 0 0 14px;
          }
          .rd-confirm-impact-grid {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(120px,1fr)); gap: 12px;
          }
          .rd-confirm-metric {
            background: var(--page-bg,#F2F8F5); border-radius: 8px; padding: 12px 14px;
          }
          .rd-confirm-metric-label {
            font-size: 10px; font-weight: 700; text-transform: uppercase;
            letter-spacing: .05em; color: var(--text-muted); margin-bottom: 4px;
          }
          .rd-confirm-metric-val {
            font-size: 20px; font-weight: 700; color: var(--text-primary); line-height: 1;
          }
          .rd-confirm-metric-unit { font-size: 11px; color: var(--text-secondary); }
          .rd-confirm-note {
            font-size: 12px; color: var(--text-muted); background: var(--page-bg,#F2F8F5);
            border-radius: 8px; padding: 10px 14px; margin-bottom: 24px;
            text-align: left; line-height: 1.55;
          }
          .rd-confirm-actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
          .rd-confirm-btn-primary {
            background: var(--accent-dark,#0F6E56); color: #fff; border: none;
            border-radius: 8px; padding: 10px 22px; font-size: 13.5px; font-weight: 600;
            cursor: pointer; text-decoration: none; display: inline-block;
          }
          .rd-confirm-btn-primary:hover { background: var(--accent-darker,#04342C); }
          .rd-confirm-btn-secondary {
            background: #fff; color: var(--text-secondary);
            border: 1px solid var(--border,#E3ECE8); border-radius: 8px;
            padding: 10px 22px; font-size: 13.5px; font-weight: 600;
            cursor: pointer; text-decoration: none; display: inline-block;
          }
          .rd-confirm-btn-secondary:hover { background: var(--page-bg,#F2F8F5); }
        `}</style>

        <div className="rd-confirm-page">
          <div className="rd-confirm-icon">
            {isAccepted ? "✓" : isSnoozed ? "⏱" : "✕"}
          </div>
          <h1 className="rd-confirm-title">{LABELS[decision.action] || "Decision recorded"}</h1>
          <p className="rd-confirm-sub">
            {isAccepted && decision.target
              ? `${decision.serverId} → ${decision.target} migration has been approved and logged.`
              : isAccepted
              ? `The action for ${decision.serverId} has been approved and logged.`
              : isSnoozed
              ? `${decision.serverId} will reappear in the recommendations queue in 24 hours.`
              : `${decision.serverId} has been removed from the active recommendations queue.`}
          </p>

          {isAccepted && hasImpact && (
            <div className="rd-confirm-impact">
              <p className="rd-confirm-impact-title">Estimated savings recorded</p>
              <div className="rd-confirm-impact-grid">
                {decision.energy > 0 && (
                  <div className="rd-confirm-metric">
                    <div className="rd-confirm-metric-label">Energy</div>
                    <div className="rd-confirm-metric-val">
                      {decision.energy.toFixed(1)}<span className="rd-confirm-metric-unit"> kWh</span>
                    </div>
                  </div>
                )}
                {decision.energy > 0 && (
                  <div className="rd-confirm-metric">
                    <div className="rd-confirm-metric-label">Carbon</div>
                    <div className="rd-confirm-metric-val">
                      {decision.carbon.toFixed(2)}<span className="rd-confirm-metric-unit"> kg CO₂</span>
                    </div>
                  </div>
                )}
                {decision.cost > 0 && (
                  <div className="rd-confirm-metric">
                    <div className="rd-confirm-metric-label">Cost</div>
                    <div className="rd-confirm-metric-val">₹{decision.cost.toFixed(0)}</div>
                  </div>
                )}
                {decision.storage > 0 && (
                  <div className="rd-confirm-metric">
                    <div className="rd-confirm-metric-label">Storage</div>
                    <div className="rd-confirm-metric-val">
                      {decision.storage.toFixed(0)}<span className="rd-confirm-metric-unit"> GB</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <p className="rd-confirm-note">
            {isAccepted
              ? <>This decision has been saved to the approved actions log. Impact figures are estimates captured at
                decision time — GreenOps records what was projected, not what was physically executed.
                Head to <strong>Approved Actions</strong> to track execution and mark each action as complete once the work is done.</>
              : isSnoozed
              ? "This recommendation will reappear in the queue once the snooze window passes — nothing further to track until then."
              : "This recommendation has been dismissed and removed from the queue."}
          </p>

          <div className="rd-confirm-actions">
            <Link to="/recommendations" className="rd-confirm-btn-primary">
              Back to recommendations
            </Link>
            {isAccepted && (
              <Link to="/approved-actions" className="rd-confirm-btn-secondary">
                View approved actions →
              </Link>
            )}
          </div>
        </div>
      </>
    );
  }

  const baseImpact    = rec.impact || {};
  const isConsolidate = rec.recommendation_type === "consolidate";
  const isStorage     = ["archive", "deduplicate", "rightsize"].includes(rec.recommendation_type);
  const rejected      = isConsolidate && baseImpact.safe === false;

  const canDecide = user?.role === "infrastructure_manager";

  // Parse server type from the explanation string — backend always writes
  // "threshold for TYPE:" in the explanation for consolidation recs.
  const serverTypeMatch = rec.explanation?.match(/threshold for ([^:]+):/i);
  const serverType = serverTypeMatch ? serverTypeMatch[1].trim() : "Compute";

  // Show candidates that aren't over the CPU/memory limit RIGHT NOW --
  // filtering on cpu_memory_ok_now specifically, not the combined safe_now,
  // so a candidate rejected only on network or thermal grounds still shows
  // up (same reasoning as "Risky soon" below: those are newer, less-
  // established conventions than the CPU/memory limit, and an operator
  // should be able to see and judge them, not have them silently vanish).
  // A candidate whose own near-term CPU/memory forecast crosses the safety
  // limit (safe_now true, safe false) still shows up here as "Risky soon"
  // for the same reason. Fields predating this session's target-candidate
  // forecasting (cpu_memory_ok_now undefined) are treated as viewable,
  // same as before.
  const allCandidates  = baseImpact.candidates || [];
  const safeCandidates = allCandidates.filter(c => c.cpu_memory_ok_now !== false);

  const hasEnergy  = (effectiveImpact?.estimated_energy_saving_kwh    || 0) > 0;
  const hasStorage = (effectiveImpact?.estimated_storage_reclaimed_gb || 0) > 0;

  const isUsingAlternate = selectedCandidateId && selectedCandidateId !== baseImpact.target_server_id;

  const PRI = { high: { cls: "danger", label: "Urgent" }, medium: { cls: "warn", label: "Moderate" }, low: { cls: "good", label: "Low" } };
  const pri = PRI[rec.priority] || PRI.low;

  return (
    <>
      <style>{`
        .rd-back {
          display: inline-flex; align-items: center; gap: 5px;
          font-size: 13px; color: var(--text-secondary); text-decoration: none;
          margin-bottom: 14px;
        }
        .rd-back:hover { color: var(--accent-dark); }

        /* ── Page header ─────────────────────────── */
        .rd-header {
          display: flex; align-items: flex-start;
          justify-content: space-between; gap: 16px; margin-bottom: 20px;
        }
        .rd-header-type {
          font-size: 11px; font-weight: 700; text-transform: uppercase;
          letter-spacing: .07em; color: var(--text-muted); margin-bottom: 6px;
        }
        .rd-header h1 {
          font-size: 22px; font-weight: 700; color: var(--text-primary); margin: 0 0 6px;
        }
        .rd-header-meta {
          font-size: 13px; color: var(--text-secondary); margin: 0;
        }
        .rd-header-meta a { color: var(--accent-dark); text-decoration: none; }
        .rd-header-meta a:hover { text-decoration: underline; }

        /* ── Cards ──────────────────────────────── */
        .rd-card {
          background: #fff; border: 1px solid var(--border, #E3ECE8);
          border-radius: 12px; padding: 20px 22px; margin-bottom: 16px;
          box-shadow: 0 1px 3px rgba(4,52,44,.04);
        }
        .rd-card-title {
          font-size: 14px; font-weight: 700; color: var(--text-primary); margin: 0 0 4px;
        }
        .rd-card-sub {
          font-size: 12.5px; color: var(--text-secondary); margin: 0 0 16px; line-height: 1.5;
        }

        /* ── Alternate target banner ─────────────── */
        .rd-alternate-banner {
          display: flex; align-items: center; justify-content: space-between;
          gap: 12px; background: #EDF7F2;
          border: 1px solid #C3E6D4; border-radius: 8px;
          padding: 10px 14px; margin-bottom: 16px; font-size: 13px;
        }
        .rd-alternate-banner strong { color: var(--accent-dark); }
        .rd-alternate-reset {
          background: none; border: none; cursor: pointer; font-size: 12px;
          color: var(--text-muted); text-decoration: underline; padding: 0; white-space: nowrap;
        }
        .rd-alternate-reset:hover { color: var(--accent-dark); }

        /* ── Impact metric grid ──────────────────── */
        .rd-impact-grid {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
          gap: 12px; margin-bottom: 16px;
        }
        .rd-impact-cell {
          background: var(--page-bg, #F2F8F5); border-radius: 10px;
          padding: 14px 16px; display: flex; flex-direction: column; gap: 4px;
          position: relative; cursor: default;
        }
        .rd-impact-cell:hover { background: #EBF4EF; }
        .rd-impact-cell-label {
          font-size: 10.5px; font-weight: 700; text-transform: uppercase;
          letter-spacing: .06em; color: var(--text-muted);
        }
        .rd-impact-cell-value {
          font-size: 24px; font-weight: 700; color: var(--text-primary); line-height: 1.1;
        }
        .rd-impact-cell-unit { font-size: 12px; color: var(--text-secondary); font-weight: 400; }
        .rd-impact-cell-sub  { font-size: 11px; color: var(--text-muted); }

        /* hover tooltip on each impact cell */
        .rd-impact-cell-tooltip {
          display: none;
          position: absolute;
          bottom: calc(100% + 8px);
          left: 0;
          width: 260px;
          background: #1C2622;
          color: #E8F2EE;
          font-size: 11.5px;
          line-height: 1.5;
          padding: 10px 13px;
          border-radius: 8px;
          box-shadow: 0 6px 20px rgba(4,52,44,.22);
          z-index: 30;
          pointer-events: none;
          white-space: normal;
        }
        .rd-impact-cell-tooltip::after {
          content: "";
          position: absolute;
          top: 100%; left: 18px;
          border: 5px solid transparent;
          border-top-color: #1C2622;
        }
        .rd-impact-cell:hover .rd-impact-cell-tooltip { display: block; }

        /* ── Visual row (gauge + chart) ──────────── */
        .rd-visual-row {
          display: grid; grid-template-columns: 150px 1fr; gap: 20px;
          align-items: start; margin-bottom: 16px;
        }
        .rd-visual-heading {
          font-size: 10.5px; font-weight: 700; text-transform: uppercase;
          letter-spacing: .06em; color: var(--text-muted); margin: 0 0 8px;
        }

        /* ── Risk gauge ─────────────────────────── */
        .rd-gauge-wrap { display: flex; flex-direction: column; align-items: center; gap: 2px; }
        .rd-gauge-chart { position: relative; }
        .rd-gauge-label {
          position: absolute; inset: 0;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center; pointer-events: none;
        }
        .rd-gauge-value { font-size: 20px; font-weight: 700; }
        .rd-gauge-sub {
          font-size: 9.5px; color: var(--text-muted); font-weight: 700;
          text-transform: uppercase; letter-spacing: .04em;
        }
        .rd-gauge-hint { font-size: 10.5px; color: var(--text-muted); text-align: center; margin: 0; }

        /* ── Post-move chart ────────────────────── */
        .rd-chart-wrap { }
        .rd-chart-sub { font-size: 12px; color: var(--text-secondary); margin: 0 0 10px; }

        /* ── Candidates section ──────────────────── */
        .rd-candidates-intro {
          display: flex; align-items: center; justify-content: space-between;
          gap: 12px; margin-bottom: 12px;
        }
        .rd-candidates-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(175px, 1fr)); gap: 10px;
        }
        .rd-candidate-card {
          background: var(--page-bg, #F2F8F5);
          border: 1.5px solid var(--border, #E3ECE8);
          border-radius: 10px; padding: 14px; cursor: pointer;
          text-align: left; transition: box-shadow .15s, border-color .15s;
          width: 100%;
        }
        .rd-candidate-card:hover {
          border-color: var(--accent, #1D9E75);
          box-shadow: 0 2px 8px rgba(29,158,117,.1);
        }
        .rd-candidate-card.selected {
          background: #fff;
          border-color: var(--accent-dark, #0F6E56);
          box-shadow: 0 0 0 3px rgba(29,158,117,.12);
        }
        .rd-candidate-top {
          display: flex; align-items: center;
          justify-content: space-between; gap: 8px; margin-bottom: 12px;
        }
        .rd-candidate-id {
          font-size: 16px; font-weight: 800; color: var(--text-primary);
          font-family: "SFMono-Regular", Consolas, monospace;
        }
        .rd-candidate-metrics { display: flex; flex-direction: column; gap: 8px; }
        .rd-candidate-metric  { }
        .rd-candidate-metric-row {
          display: flex; justify-content: space-between; margin-bottom: 3px;
        }
        .rd-candidate-metric-label {
          font-size: 10.5px; color: var(--text-muted); font-weight: 600;
          text-transform: uppercase; letter-spacing: .04em;
        }
        .rd-candidate-metric-val { font-size: 10.5px; font-weight: 700; }
        .rd-candidate-bar-track {
          height: 5px; background: var(--border, #E3ECE8);
          border-radius: 3px; position: relative; overflow: visible;
        }
        .rd-candidate-bar-fill { height: 100%; border-radius: 3px; transition: width .3s; }
        .rd-candidate-bar-limit {
          position: absolute; top: -3px; left: 75%;
          width: 1.5px; height: 11px; background: #E24B4A; border-radius: 1px;
        }
        .rd-candidate-selected-hint {
          margin-top: 8px; font-size: 10.5px; color: var(--accent-dark);
          font-weight: 600; text-align: center;
        }
        .rd-candidate-forecast {
          margin-top: 8px; font-size: 10.5px; color: var(--text-muted);
          text-align: center; border-top: 1px dashed var(--border, #E3ECE8);
          padding-top: 6px;
        }

        /* ── Rejected state ──────────────────────── */
        .rd-rejected {
          background: var(--danger-bg, #FAECE7); border-radius: 8px;
          padding: 14px 16px; font-size: 13.5px; color: var(--danger-text, #993C1D); line-height: 1.55;
        }

        /* ── Decision buttons ────────────────────── */
        .rd-decision-row { display: flex; gap: 10px; flex-wrap: wrap; }
        .rd-btn-primary {
          background: var(--accent-dark, #0F6E56); color: #fff; border: none;
          border-radius: 8px; padding: 9px 20px; font-size: 13.5px; font-weight: 600;
          cursor: pointer; transition: background .15s;
        }
        .rd-btn-primary:hover:not(:disabled) { background: var(--accent-darker, #04342C); }
        .rd-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
        .rd-btn-secondary {
          background: #fff; color: var(--text-secondary);
          border: 1px solid var(--border, #E3ECE8); border-radius: 8px;
          padding: 9px 20px; font-size: 13.5px; font-weight: 600;
          cursor: pointer; transition: background .15s;
        }
        .rd-btn-secondary:hover:not(:disabled) { background: var(--page-bg, #F2F8F5); }
        .rd-btn-secondary:disabled { opacity: .5; cursor: not-allowed; }
        .rd-btn-danger {
          background: #fff; color: var(--danger-text, #993C1D);
          border: 1px solid var(--border, #E3ECE8); border-radius: 8px;
          padding: 9px 20px; font-size: 13.5px; font-weight: 600;
          cursor: pointer; transition: background .15s;
        }
        .rd-btn-danger:hover:not(:disabled) {
          background: var(--danger-bg, #FAECE7); border-color: var(--danger-text, #993C1D);
        }
        .rd-btn-danger:disabled { opacity: .5; cursor: not-allowed; }

        /* ── Telemetry context chart ────────────── */
        .rd-telemetry-chart {
          background: var(--page-bg, #F2F8F5);
          border-radius: 10px; padding: 14px 16px; margin-top: 0;
        }
        .rd-telemetry-chart-header {
          display: flex; align-items: flex-start;
          justify-content: space-between; gap: 12px; margin-bottom: 10px;
        }
        .rd-telemetry-chart-title {
          display: block; font-size: 12.5px; font-weight: 700;
          color: var(--text-primary, #1C2622); margin-bottom: 2px;
        }
        .rd-telemetry-chart-sub {
          display: block; font-size: 11px; color: var(--text-muted, #8A9691);
        }
        .rd-telemetry-stats {
          display: flex; gap: 14px; flex-shrink: 0;
        }
        .rd-telemetry-stat {
          display: flex; flex-direction: column; align-items: flex-end; gap: 1px;
        }
        .rd-telemetry-stat-label {
          font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
          color: var(--text-muted, #8A9691); font-weight: 600;
        }
        .rd-telemetry-stat-val {
          font-size: 15px; font-weight: 700; color: var(--text-primary, #1C2622); line-height: 1;
        }

        @media (max-width: 640px) {
          .rd-visual-row { grid-template-columns: 1fr; }
          .rd-impact-grid { grid-template-columns: repeat(2, 1fr); }
          .rd-candidates-grid { grid-template-columns: repeat(2, 1fr); }
        }
      `}</style>

      <Link to="/recommendations" className="rd-back">← Recommendations</Link>

      {/* Header */}
      <div className="rd-header">
        <div>
          <p className="rd-header-type">{typeLabel(rec.recommendation_type)}</p>
          <h1>{rec.server_id}</h1>
          <p className="rd-header-meta">
            <Link to={`/servers/${rec.server_id}`}>{rec.server_id}</Link>
            {" · Flagged "}
            {rec.created_at
              ? new Date(rec.created_at.endsWith("Z") ? rec.created_at : `${rec.created_at}Z`).toLocaleString()
              : "—"}
          </p>
        </div>
        <span className={`badge ${pri.cls}`} style={{ fontSize: 13, whiteSpace: "nowrap" }}>
          {pri.label} priority
        </span>
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Why flagged */}
      <div className="rd-card">
        <p className="rd-card-title">Why this was flagged</p>
        <p style={{ fontSize: 14, lineHeight: 1.65, color: "var(--text-secondary)", margin: 0 }}>
          {rec.explanation}
        </p>
      </div>

      {/* Storage telemetry context — only for storage recs */}
      {isStorage && (
        <div className="rd-card">
          <p className="rd-card-title" style={{ marginBottom: 4 }}>Storage utilisation</p>
          <p className="rd-card-sub">
            Current storage allocation showing active data, redundant/wasted capacity, and free space.
          </p>
          <StorageBreakdownChart serverId={rec.server_id} recType={rec.recommendation_type} />
        </div>
      )}

      {/* Candidate target selector — consolidation, show whenever there's at least one safe candidate */}
      {isConsolidate && safeCandidates.length >= 1 && (
        <div className="rd-card">
          <div className="rd-candidates-intro">
            <div>
              <p className="rd-card-title" style={{ marginBottom: 4 }}>Target server</p>
              <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: 0 }}>
                {safeCandidates.length === 1
                  ? "One same-type server in the same region is below the CPU/memory limit right now. Check its badge, since it can still be marked \"Risky soon\" or blocked on network/thermal grounds. The impact estimates below reflect this server unless a different one is selected."
                  : "Same-type servers in the same region that are below the CPU/memory limit right now, ranked by most headroom after the move. This includes any marked \"Risky soon\", \"Network limit\", or \"Thermal limit\", so you can see what was considered, not just the top pick. Click one to see how the impact estimates change."}
              </p>
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0" }}>
                CPU and Memory on each card are that server's load <strong>after</strong> it
                takes on this workload (its own current load plus 90% of the idle server's).
                The marker on each bar is the 75% safety limit.
              </p>
            </div>
          </div>
          <div className="rd-candidates-grid">
            {safeCandidates.map((c) => {
              const activeId = selectedCandidateId || baseImpact.target_server_id;
              return (
                <CandidateCard
                  key={c.server_id}
                  c={c}
                  isSelected={c.server_id === activeId}
                  onSelect={safeCandidates.length > 1 ? (candidate) => setSelectedCandidateId(candidate.server_id) : () => {}}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Estimated impact */}
      <div className="rd-card">
        <p className="rd-card-title">Estimated impact</p>
        <p className="rd-card-sub">
          {hasEnergy
            ? <>Showing estimated savings if workload moves to <strong>{effectiveImpact?.target_server_id}</strong>. Estimated over one hour of operation.</>
            : "No energy effect is modelled for storage-only actions — freeing capacity doesn't change power draw."}
        </p>

        {/* Alternate target notice */}
        {isUsingAlternate && (
          <div className="rd-alternate-banner">
            <span>
              Showing re-scaled estimates for <strong>{effectiveImpact?.target_server_id}</strong> instead of the top-ranked target ({baseImpact.target_server_id}).
              Values are proportionally adjusted based on post-move CPU ratio.
            </span>
            <button className="rd-alternate-reset" onClick={() => setSelectedCandidateId(null)}>
              Reset to top pick
            </button>
          </div>
        )}

        {rejected ? (
          <div className="rd-rejected">
            {baseImpact.assumptions?.[0] || "No server currently has enough headroom to safely absorb this workload."}
          </div>
        ) : (
          <>
            {/* Metric cells */}
            <div className="rd-impact-grid">
              {hasEnergy && (
                <>
                  <div className="rd-impact-cell">
                    <span className="rd-impact-cell-label">Energy saved</span>
                    <span className="rd-impact-cell-value">
                      {fmt(effectiveImpact?.estimated_energy_saving_kwh, 2)}
                      <span className="rd-impact-cell-unit"> kWh</span>
                    </span>
                    <span className="rd-impact-cell-sub">facility power freed</span>
                    <div className="rd-impact-cell-tooltip">
                      Target server's current facility power × (post-move CPU / current CPU). Estimates how much facility power is freed over one hour when the source workload is removed.
                    </div>
                  </div>
                  <div className="rd-impact-cell">
                    <span className="rd-impact-cell-label">Carbon cut</span>
                    <span className="rd-impact-cell-value">
                      {fmt(effectiveImpact?.estimated_carbon_reduction_kg, 2)}
                      <span className="rd-impact-cell-unit"> kg CO₂</span>
                    </span>
                    <span className="rd-impact-cell-sub">at {effectiveImpact?.emission_factor_kg_per_kwh ?? "—"} kg/kWh grid</span>
                    <div className="rd-impact-cell-tooltip">
                      Energy saved (kWh) × {effectiveImpact?.emission_factor_kg_per_kwh ?? "—"} kg CO₂/kWh grid emission factor (set in site settings). Grid average — actual emissions depend on the live grid mix.
                    </div>
                  </div>
                  <div className="rd-impact-cell">
                    <span className="rd-impact-cell-label">Cost saving</span>
                    <span className="rd-impact-cell-value">
                      ₹{fmt(effectiveImpact?.estimated_cost_saving, 0)}
                    </span>
                    <span className="rd-impact-cell-sub">at ₹8/kWh tariff</span>
                    <div className="rd-impact-cell-tooltip">
                      Energy saved (kWh) × ₹8/kWh electricity tariff. Adjust the tariff in Preferences to reflect your actual rate.
                    </div>
                  </div>
                  {(effectiveImpact?.estimated_water_saving_l || 0) > 0 && (
                    <div className="rd-impact-cell">
                      <span className="rd-impact-cell-label">Water saving</span>
                      <span className="rd-impact-cell-value">
                        {fmt(effectiveImpact?.estimated_water_saving_l, 1)}
                        <span className="rd-impact-cell-unit"> L</span>
                      </span>
                      <span className="rd-impact-cell-sub">cooling load freed</span>
                      <div className="rd-impact-cell-tooltip">
                        Energy saved × WUE factor for the source server's cooling type (Air: 0.3 L/kWh, Liquid: 0.9 L/kWh, Hybrid: 1.8 L/kWh). Freeing the server removes its cooling water draw.
                      </div>
                    </div>
                  )}
                </>
              )}
              {hasStorage && (
                <div className="rd-impact-cell">
                  <span className="rd-impact-cell-label">Storage reclaimed</span>
                  <span className="rd-impact-cell-value">
                    {fmt(effectiveImpact?.estimated_storage_reclaimed_gb, 1)}
                    <span className="rd-impact-cell-unit"> GB</span>
                  </span>
                  <span className="rd-impact-cell-sub">capacity recovered</span>
                  <div className="rd-impact-cell-tooltip">
                    {isConsolidate
                      ? "Consolidation does not reclaim storage — only the server's power draw is reduced."
                      : "Reclaimable capacity identified by the rules engine: duplicate data volume, stale data volume, or over-provisioned allocation beyond observed usage."}
                  </div>
                </div>
              )}
            </div>

            {/* Risk gauge + post-move chart */}
            {isConsolidate && (
              <div className="rd-visual-row">
                <RiskGauge score={effectiveImpact?.risk_score} />
                <PostMoveChart
                  postCpu={effectiveImpact?.post_move_cpu}
                  postMemory={effectiveImpact?.post_move_memory}
                  targetId={effectiveImpact?.target_server_id}
                />
              </div>
            )}

          </>
        )}
      </div>

      {/* Decision — infrastructure_manager only */}
      <div className="rd-card">
        <p className="rd-card-title">Decision</p>
        <p className="rd-card-sub" style={{ marginBottom: 16 }}>
          Recording a decision here marks this recommendation as resolved and removes it from the queue.
          {isUsingAlternate && <> You have selected <strong>{effectiveImpact?.target_server_id}</strong> as the target.</>}
        </p>
        {canDecide ? (
          <div className="rd-decision-row">
            {(!isConsolidate || !rejected) && (
              <button
                className="rd-btn-primary"
                onClick={() => handleAction(acceptActionFor(rec.recommendation_type))}
                disabled={actLoad}
              >
                ✓ {acceptLabelFor(rec.recommendation_type)}{isUsingAlternate ? ` to ${effectiveImpact?.target_server_id}` : ""}
              </button>
            )}
            <button className="rd-btn-secondary" onClick={() => handleAction("snooze", 24)} disabled={actLoad}>
              ⏱ Snooze 24h
            </button>
            <button className="rd-btn-danger" onClick={() => handleAction("do_nothing")} disabled={actLoad}>
              Dismiss
            </button>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic", margin: 0 }}>
            View only — approving or dismissing recommendations requires the Infrastructure Manager role.
          </p>
        )}
      </div>
    </>
  );
}
