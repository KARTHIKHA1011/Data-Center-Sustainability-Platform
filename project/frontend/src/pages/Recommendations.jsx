import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
  PieChart, Pie,
} from "recharts";
import api from "../api";
import { useAuth } from "../AuthContext";

/* ─── Action metadata ─────────────────────────────────────────── */

const ACTION = {
  consolidate: { verb: "Workload consolidation", icon: "⇄", acceptLabel: "Approve consolidation" },
  rightsize:   { verb: "Storage right-sizing",   icon: "⬍", acceptLabel: "Approve right-sizing" },
  archive:     { verb: "Archive to cold storage", icon: "🗄", acceptLabel: "Approve archival" },
  deduplicate: { verb: "Remove duplicate files",  icon: "⊘", acceptLabel: "Approve deduplication" },
};

/* ─── Target forecast (CPU) ───────────────────────────────────── */
// Single scannable number, not the full explanation -- the ranked candidate
// table with the "Risky soon" badge and forecast reasoning still only lives
// on the detail page. This just surfaces the winning candidate's own
// current -> predicted CPU so triage doesn't require opening every card.
function targetForecast(rec) {
  const target = rec.impact?.target_server_id;
  const candidates = rec.impact?.candidates || [];
  if (!target) return null;
  const match = candidates.find((c) => c.server_id === target);
  if (!match || match.forecast_predicted_cpu == null || match.current_cpu == null) return null;
  const delta = match.forecast_predicted_cpu - match.current_cpu;
  return {
    measured: match.current_cpu,
    predicted: match.forecast_predicted_cpu,
    arrow: delta > 0.5 ? "▲" : delta < -0.5 ? "▼" : "▬",
  };
}

/* ─── Plain-language "why" ────────────────────────────────────── */

function buildWhy(rec) {
  const imp  = rec.impact || {};
  const type = rec.recommendation_type;
  const sid  = rec.server_id;
  switch (type) {
    case "consolidate": {
      const avg    = imp.source_avg_cpu ?? imp.avg_cpu;
      const target = imp.target_server_id;
      if (avg != null)
        return `${sid} has sustained an average CPU utilisation of ${parseFloat(avg).toFixed(1)}% over the past 6 hours, well below the idle threshold for its server type. Active workloads can be safely migrated to ${target || "an alternative host"}, allowing this node to be decommissioned and removed from the active power pool.`;
      return `${sid} is operating significantly below its utilisation threshold. Migrating its workloads to ${target || "an alternative host"} will allow this node to be shut down, reducing unnecessary power consumption.`;
    }
    case "rightsize": {
      const reclaim = imp.estimated_storage_reclaimed_gb;
      if (reclaim) return `${sid} has ${reclaim.toFixed(0)} GB of storage provisioned beyond its actual usage. Reducing the allocation to match observed consumption will reclaim capacity for other workloads and eliminate waste in the storage tier.`;
      return `${sid} has significantly more storage provisioned than it consumes. Right-sizing the allocation to reflect actual usage will free capacity and reduce provisioning overhead.`;
    }
    case "archive": {
      const days = imp.last_accessed_days ?? imp.stale_days;
      if (days != null)
        return `Data on ${sid} has not been accessed in ${days} days. Retaining it on high-performance active storage is unnecessary. Migrating to cold (archive) storage preserves accessibility while substantially reducing storage costs.`;
      return `Data on ${sid} has not been accessed recently. Transitioning it to cold storage will maintain data availability at a significantly lower cost.`;
    }
    case "deduplicate": {
      const dupGb  = imp.duplicate_data_gb ?? imp.estimated_storage_reclaimed_gb;
      const dupPct = imp.duplicate_pct;
      if (dupGb != null)
        return `${dupPct ? (dupPct * 100).toFixed(0) + "%" : "A significant proportion"} of files on ${sid} are exact duplicates — accounting for ${dupGb.toFixed(1)} GB of redundant data. Deduplication will remove these copies while retaining one canonical instance of each file, with no data loss.`;
      return `${sid} contains a high volume of duplicate files. Deduplication will reclaim the wasted capacity while preserving data integrity.`;
    }
    default:
      return rec.explanation || "A monitoring rule was triggered on this server.";
  }
}

/* ─── Priority style ──────────────────────────────────────────── */

const PRI_STYLE = {
  high:   { label: "Urgent",   cls: "danger" },
  medium: { label: "Moderate", cls: "warn" },
  low:    { label: "Low",      cls: "good" },
};

/* ─── Impact mini-bar chart inside each card ──────────────────── */

function ImpactMiniChart({ imp }) {
  const energy  = imp.estimated_energy_saving_kwh    || 0;
  const carbon  = imp.estimated_carbon_reduction_kg  || 0;
  const cost    = imp.estimated_cost_saving          || 0;
  const storage = imp.estimated_storage_reclaimed_gb || 0;

  const hasEnergy  = energy  > 0;
  const hasStorage = storage > 0;

  if (!hasEnergy && !hasStorage) return null;

  // Build assumption tooltip text from the first assumption (calculation method)
  const assumptions = imp.assumptions || [];
  const calcNote = assumptions[0] || null;

  if (hasEnergy) {
    const data = [
      { name: "Energy", value: parseFloat(energy.toFixed(2)),  unit: "kWh",     fill: "#1D9E75" },
      { name: "Carbon", value: parseFloat(carbon.toFixed(2)),  unit: "kg CO₂",  fill: "#0F6E56" },
      { name: "Cost",   value: parseFloat(cost.toFixed(0)),    unit: "₹ saved", fill: "#5DCAA5" },
    ].filter(d => d.value > 0);

    // Use a consistent domain so bars are comparable across cards:
    // domain max = cost (usually the largest number), clamped to prevent
    // tiny energy/carbon bars from dominating
    const domainMax = Math.max(energy, carbon, cost, 1);

    return (
      <div className="rcard-impact">
        <div className="rcard-impact-header">
          <span className="rcard-impact-label">Estimated impact</span>
          {calcNote && (
            <div className="rcard-impact-info" title={calcNote}>
              <span className="rcard-impact-info-icon">ⓘ</span>
              <div className="rcard-impact-info-tooltip">{calcNote}</div>
            </div>
          )}
        </div>
        <div className="rcard-impact-row">
          <div className="rcard-impact-chart">
            <ResponsiveContainer width="100%" height={52}>
              <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                <XAxis type="number" domain={[0, domainMax]} hide />
                <YAxis type="category" dataKey="name" width={44} tick={{ fontSize: 10, fill: "#8A9691" }} axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: "rgba(4,52,44,.04)" }}
                  wrapperStyle={{ outline: "none", border: "none", boxShadow: "none" }}
                  content={({ payload }) => {
                    if (!payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div style={{ background: "#fff", border: "1px solid #E3ECE8", borderRadius: 6, padding: "6px 10px", fontSize: 12, maxWidth: 260 }}>
                        <strong>{d.value} {d.unit}</strong>
                        {calcNote && <div style={{ color: "#8A9691", fontSize: 10.5, marginTop: 4, lineHeight: 1.45 }}>{calcNote}</div>}
                      </div>
                    );
                  }}
                />
                <Bar dataKey="value" radius={[0, 3, 3, 0]} barSize={10}>
                  {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="rcard-impact-stats">
            {energy > 0 && <div className="rcard-impact-stat"><span className="rcard-impact-stat-val">{energy.toFixed(1)}</span><span className="rcard-impact-stat-unit">kWh</span></div>}
            {carbon > 0 && <div className="rcard-impact-stat"><span className="rcard-impact-stat-val">{carbon.toFixed(2)}</span><span className="rcard-impact-stat-unit">kg CO₂</span></div>}
            {cost   > 0 && <div className="rcard-impact-stat"><span className="rcard-impact-stat-val">₹{cost.toFixed(0)}</span><span className="rcard-impact-stat-unit">saved</span></div>}
          </div>
        </div>
      </div>
    );
  }

  // Storage-only
  const storageNote = assumptions[0] || null;
  return (
    <div className="rcard-impact">
      <div className="rcard-impact-header">
        <span className="rcard-impact-label">Estimated impact</span>
        {storageNote && (
          <div className="rcard-impact-info" title={storageNote}>
            <span className="rcard-impact-info-icon">ⓘ</span>
            <div className="rcard-impact-info-tooltip">{storageNote}</div>
          </div>
        )}
      </div>
      <div className="rcard-impact-storage">
        <span className="rcard-impact-storage-val">{storage.toFixed(1)} GB</span>
        <span className="rcard-impact-storage-sub">storage reclaimed</span>
      </div>
    </div>
  );
}

/* ─── Single card ─────────────────────────────────────────────── */

function RecCard({ rec, onAction, actLoading, canDecide }) {
  const [busy, setBusy] = useState(false);
  const type    = rec.recommendation_type;
  const meta    = ACTION[type] || ACTION.consolidate;
  const pri     = PRI_STYLE[rec.priority] || PRI_STYLE.low;
  const why     = buildWhy(rec);
  const target  = rec.impact?.target_server_id;
  const blocked = type === "consolidate" && rec.impact?.safe === false;
  const apiAction = type === "consolidate" ? "consolidate" : "rightsize";
  const tf = type === "consolidate" ? targetForecast(rec) : null;

  const act = async (action, snoozeHours) => {
    setBusy(true);
    await onAction(rec.id, action, snoozeHours);
    setBusy(false);
  };

  return (
    <div className="rcard">
      <div className="rcard-inner">
        {/* head row */}
        <div className="rcard-head">
          <div className="rcard-action-chip">
            <span>{meta.icon}</span>
            <span>{meta.verb}</span>
          </div>
          <span className={`badge ${pri.cls}`}>{pri.label}</span>
        </div>

        {/* server + target */}
        <div className="rcard-server-row">
          <Link to={`/servers/${rec.server_id}`} className="rcard-server-id">
            {rec.server_id}
          </Link>
          {type !== "consolidate" && (
            <span className="rcard-server-type">{rec.server_type || ""}</span>
          )}
          {type === "consolidate" && !blocked && target && (
            <span className="rcard-target-badge">→ move to {target}</span>
          )}
          {blocked && (
            <span className="rcard-blocked-badge">⚠ no safe target right now</span>
          )}
          {tf && (
            <span
              className="rcard-target-badge"
              title={`${target}'s own current → predicted CPU, independent of this move`}
            >
              Target forecast: {tf.measured}% {tf.arrow} {tf.predicted}%
            </span>
          )}
        </div>

        {/* explanation */}
        <p className="rcard-why">{why}</p>

        {/* impact chart */}
        <ImpactMiniChart imp={rec.impact || {}} />

        {/* buttons — only infrastructure_manager can approve/snooze/dismiss */}
        <div className="rcard-btns">
          {canDecide ? (
            <>
              {!blocked && (
                <button className="rcard-btn accept" disabled={busy || actLoading} onClick={() => act(apiAction)}>
                  ✓ {meta.acceptLabel}
                </button>
              )}
              <button className="rcard-btn snooze" disabled={busy || actLoading} onClick={() => act("snooze", 24)}>
                Snooze 24h
              </button>
              <button className="rcard-btn dismiss" disabled={busy || actLoading} onClick={() => act("do_nothing")}>
                Dismiss
              </button>
            </>
          ) : (
            <span style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
              View only — approval requires Infrastructure Manager role
            </span>
          )}
          <Link to={`/recommendations/${rec.id}`} className="rcard-detail-link">
            See full analysis →
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ─── Right-hand summary sidebar ─────────────────────────────── */

function RecSidebar({ recs }) {
  if (!recs.length) return null;

  const totalEnergy  = recs.reduce((s, r) => s + (r.impact?.estimated_energy_saving_kwh    || 0), 0);
  const totalCarbon  = recs.reduce((s, r) => s + (r.impact?.estimated_carbon_reduction_kg  || 0), 0);
  const totalCost    = recs.reduce((s, r) => s + (r.impact?.estimated_cost_saving          || 0), 0);
  const totalStorage = recs.reduce((s, r) => s + (r.impact?.estimated_storage_reclaimed_gb || 0), 0);

  const byPriority = [
    { name: "Urgent",   value: recs.filter(r => r.priority === "high").length,   fill: "#E24B4A" },
    { name: "Moderate", value: recs.filter(r => r.priority === "medium").length, fill: "#D97706" },
    { name: "Low",      value: recs.filter(r => r.priority === "low").length,    fill: "#1D9E75" },
  ].filter(d => d.value > 0);

  const byType = [
    { name: "Consolidation", value: recs.filter(r => r.recommendation_type === "consolidate").length,  fill: "#0F6E56" },
    { name: "Right-size",    value: recs.filter(r => r.recommendation_type === "rightsize").length,    fill: "#1D9E75" },
    { name: "Archive",       value: recs.filter(r => r.recommendation_type === "archive").length,      fill: "#5DCAA5" },
    { name: "Deduplicate",   value: recs.filter(r => r.recommendation_type === "deduplicate").length,  fill: "#93E2C3" },
  ].filter(d => d.value > 0);

  const hasSavings = totalEnergy > 0 || totalCost > 0 || totalStorage > 0;

  return (
    <aside className="rec-sidebar">
      {/* Potential savings */}
      {hasSavings && (
        <div className="rec-sidebar-card">
          <p className="rec-sidebar-card-title">Potential savings</p>
          <p className="rec-sidebar-card-sub">If all pending items are resolved</p>
          <div className="rec-sidebar-stat-list">
            {totalEnergy > 0 && (
              <div className="rec-sidebar-stat">
                <span className="rec-sidebar-stat-label">Energy</span>
                <span className="rec-sidebar-stat-val">{totalEnergy.toFixed(1)} <span className="rec-sidebar-stat-unit">kWh</span></span>
              </div>
            )}
            {totalCarbon > 0 && (
              <div className="rec-sidebar-stat">
                <span className="rec-sidebar-stat-label">Carbon</span>
                <span className="rec-sidebar-stat-val">{totalCarbon.toFixed(2)} <span className="rec-sidebar-stat-unit">kg CO₂</span></span>
              </div>
            )}
            {totalCost > 0 && (
              <div className="rec-sidebar-stat">
                <span className="rec-sidebar-stat-label">Cost</span>
                <span className="rec-sidebar-stat-val">₹{totalCost.toFixed(0)}</span>
              </div>
            )}
            {totalStorage > 0 && (
              <div className="rec-sidebar-stat">
                <span className="rec-sidebar-stat-label">Storage</span>
                <span className="rec-sidebar-stat-val">{totalStorage.toFixed(0)} <span className="rec-sidebar-stat-unit">GB</span></span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Priority breakdown donut */}
      {byPriority.length > 0 && (
        <div className="rec-sidebar-card">
          <p className="rec-sidebar-card-title">Priority breakdown</p>
          <ResponsiveContainer width="100%" height={140}>
            <PieChart>
              <Pie
                data={byPriority}
                cx="50%" cy="50%"
                innerRadius={38} outerRadius={58}
                dataKey="value"
                paddingAngle={3}
              >
                {byPriority.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Pie>
              <Tooltip
                content={({ payload }) => {
                  if (!payload?.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div style={{ background: "#fff", border: "1px solid #E3ECE8", borderRadius: 6, padding: "5px 10px", fontSize: 12 }}>
                      <strong style={{ color: d.fill }}>{d.name}</strong>: {d.value}
                    </div>
                  );
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="rec-sidebar-legend">
            {byPriority.map(d => (
              <div key={d.name} className="rec-sidebar-legend-item">
                <span className="rec-sidebar-legend-dot" style={{ background: d.fill }} />
                <span>{d.name}</span>
                <strong>{d.value}</strong>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Type breakdown bar chart */}
      {byType.length > 1 && (
        <div className="rec-sidebar-card">
          <p className="rec-sidebar-card-title">By action type</p>
          <ResponsiveContainer width="100%" height={byType.length * 34 + 8}>
            <BarChart data={byType} layout="vertical" margin={{ top: 4, right: 28, left: 4, bottom: 4 }}>
              <XAxis type="number" hide domain={[0, 'dataMax']} />
              <YAxis type="category" dataKey="name" width={82} tick={{ fontSize: 11, fill: "#5F6E68" }} axisLine={false} tickLine={false} />
              <Tooltip
                cursor={{ fill: "rgba(4,52,44,.04)" }}
                content={({ payload }) => {
                  if (!payload?.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div style={{ background: "#fff", border: "1px solid #E3ECE8", borderRadius: 6, padding: "5px 10px", fontSize: 12 }}>
                      <strong>{d.name}</strong>: {d.value}
                    </div>
                  );
                }}
              />
              <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={12}
                label={{ position: "right", fontSize: 11, fill: "#1C2622" }}>
                {byType.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Footer link */}
      <p className="rec-sidebar-footnote">
        Scoring weights in <Link to="/preferences">Preferences</Link>
      </p>
    </aside>
  );
}

/* ─── Empty state ─────────────────────────────────────────────── */

function EmptyState({ filtered, total }) {
  return (
    <div className="rec-empty">
      <div className="rec-empty-blob">🌿</div>
      <h3>{filtered < total ? "Nothing in this category" : "You're all caught up!"}</h3>
      <p>
        {filtered < total
          ? "Try switching the tab above to see all recommendations."
          : "No pending recommendations right now — every server and storage volume looks healthy."}
      </p>
    </div>
  );
}

/* ─── Main page ───────────────────────────────────────────────── */

const PRIORITY_TIER = { high: 0, medium: 1, low: 2 };

export default function Recommendations() {
  const [recs,       setRecs]       = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState("");
  const [actLoading, setActLoading] = useState(false);
  const [toast,      setToast]      = useState("");
  const [filter,     setFilter]     = useState("all");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const res = await api.recommendations(false);
      setRecs(res.data || []);
    } catch (e) {
      setError(e.response?.data?.detail || "Couldn't reach the backend — make sure it's running.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAction = async (id, action, snoozeHours) => {
    try {
      setActLoading(true);
      await api.recommendationAction(id, action, "", snoozeHours);
      setRecs((prev) => prev.filter((r) => r.id !== id));
      const msgs = {
        do_nothing: "Dismissed.",
        snooze: "Snoozed — we'll remind you tomorrow.",
        consolidate: "Accepted ✓",
        rightsize: "Accepted ✓",
      };
      setToast(msgs[action] || "Decision recorded ✓");
      setTimeout(() => setToast(""), 3500);
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to record your decision.");
    } finally {
      setActLoading(false);
    }
  };

  const counts = {
    all:         recs.length,
    consolidate: recs.filter((r) => r.recommendation_type === "consolidate").length,
    storage:     recs.filter((r) => ["archive", "deduplicate", "rightsize"].includes(r.recommendation_type)).length,
  };

  const { user } = useAuth();
  const canDecide = user?.role === "infrastructure_manager";

  const sortFn = (a, b) => {
    const t = (PRIORITY_TIER[a.priority] ?? 9) - (PRIORITY_TIER[b.priority] ?? 9);
    return t !== 0 ? t : (b.score ?? 0) - (a.score ?? 0);
  };

  const shown = filter === "all"
    ? recs
    : filter === "consolidate"
      ? recs.filter((r) => r.recommendation_type === "consolidate")
      : recs.filter((r) => ["archive", "deduplicate", "rightsize"].includes(r.recommendation_type));

  const sorted = [...shown].sort(sortFn);

  const consolidateGroup = [...recs.filter(r => r.recommendation_type === "consolidate")].sort(sortFn);
  const storageGroup     = [...recs.filter(r => ["archive", "deduplicate", "rightsize"].includes(r.recommendation_type))].sort(sortFn);

  const highCount = recs.filter((r) => r.priority === "high").length; // used in sidebar

  return (
    <>
      <style>{`
        /* ── Two-column layout ───────────────────── */
        .rec-page { max-width: 1280px; }
        .rec-layout {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 260px;
          gap: 20px;
          align-items: start;
        }
        .rec-main { min-width: 0; }

        /* ── Sidebar ─────────────────────────────── */
        .rec-sidebar {
          position: sticky;
          top: 20px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .rec-sidebar-card {
          background: #fff;
          border: 1px solid var(--border, #E3ECE8);
          border-radius: 12px;
          padding: 16px 18px;
          box-shadow: 0 1px 3px rgba(4,52,44,.04);
        }
        .rec-sidebar-card-title {
          font-size: 13px; font-weight: 700;
          color: var(--text-primary, #1C2622); margin: 0 0 2px;
        }
        .rec-sidebar-card-sub {
          font-size: 11.5px; color: var(--text-muted, #8A9691);
          margin: 0 0 14px;
        }
        .rec-sidebar-stat-list { display: flex; flex-direction: column; gap: 10px; }
        .rec-sidebar-stat {
          display: flex; align-items: baseline;
          justify-content: space-between; gap: 8px;
        }
        .rec-sidebar-stat-label {
          font-size: 12px; color: var(--text-secondary, #5F6E68);
        }
        .rec-sidebar-stat-val {
          font-size: 16px; font-weight: 700; color: var(--text-primary, #1C2622);
        }
        .rec-sidebar-stat-unit {
          font-size: 11px; font-weight: 400; color: var(--text-muted, #8A9691);
        }
        .rec-sidebar-legend {
          display: flex; flex-direction: column; gap: 6px; margin-top: 4px;
        }
        .rec-sidebar-legend-item {
          display: flex; align-items: center; gap: 7px;
          font-size: 12px; color: var(--text-secondary, #5F6E68);
        }
        .rec-sidebar-legend-dot {
          width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
        }
        .rec-sidebar-legend-item strong {
          margin-left: auto; color: var(--text-primary, #1C2622);
        }
        .rec-sidebar-footnote {
          font-size: 11.5px; color: var(--text-muted, #8A9691);
          text-align: center; margin: 0;
        }
        .rec-sidebar-footnote a { color: var(--accent-dark, #0F6E56); text-decoration: none; }
        .rec-sidebar-footnote a:hover { text-decoration: underline; }

        /* ── Header ─────────────────────────────── */
        .rec-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          margin-bottom: 20px;
        }
        .rec-header-title h1 {
          font-size: 24px; font-weight: 700;
          color: var(--text-primary, #1C2622); margin: 0 0 4px;
        }
        .rec-header-title p {
          font-size: 13.5px; color: var(--text-secondary, #5F6E68); margin: 0;
        }
        .rec-refresh-btn {
          border: 1px solid var(--border, #E3ECE8); background: #fff;
          color: var(--text-secondary, #5F6E68); border-radius: 8px;
          padding: 7px 14px; font-size: 12.5px; font-weight: 600;
          cursor: pointer; transition: background .15s; white-space: nowrap;
        }
        .rec-refresh-btn:hover:not(:disabled) {
          background: var(--page-bg, #F2F8F5);
          border-color: var(--accent, #1D9E75);
          color: var(--accent-dark, #0F6E56);
        }
        .rec-refresh-btn:disabled { opacity: .5; cursor: default; }

        /* ── Summary strip ──────────────────────── */
        .rec-summary-strip {
          background: #fff; border: 1px solid var(--border, #E3ECE8);
          border-radius: 12px; padding: 0; margin-bottom: 20px;
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          box-shadow: 0 1px 3px rgba(4,52,44,.04);
          overflow: hidden;
        }
        .rec-stat-card {
          padding: 16px 20px;
          border-right: 1px solid var(--border, #E3ECE8);
          display: flex; flex-direction: column; gap: 4px;
        }
        .rec-stat-card:last-child { border-right: none; }
        .rec-stat-label {
          font-size: 11px; font-weight: 600; text-transform: uppercase;
          letter-spacing: .06em; color: var(--text-muted, #8A9691);
        }
        .rec-stat-value {
          font-size: 26px; font-weight: 700;
          color: var(--text-primary, #1C2622); line-height: 1;
        }
        .rec-stat-sub {
          font-size: 11.5px; color: var(--text-secondary, #5F6E68);
        }
        .rec-stat-badge-row {
          display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px;
        }
        .rec-stat-pip {
          display: inline-flex; align-items: center; gap: 4px;
          font-size: 11px; color: var(--text-secondary, #5F6E68);
        }
        .rec-stat-pip-dot {
          width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
        }

        /* ── Filter tabs ────────────────────────── */
        .rec-tabs {
          display: flex; gap: 4px; margin-bottom: 20px;
          background: #fff; border: 1px solid var(--border, #E3ECE8);
          border-radius: 8px; padding: 3px; width: fit-content;
        }
        .rec-tab {
          border: none; background: transparent; border-radius: 6px;
          padding: 7px 16px; font-size: 12.5px; font-weight: 600;
          color: var(--text-secondary, #5F6E68); cursor: pointer;
          transition: all .15s; display: flex; align-items: center; gap: 6px;
        }
        .rec-tab:hover { color: var(--text-primary, #1C2622); }
        .rec-tab.active { background: var(--accent-dark, #0F6E56); color: #fff; }
        .rec-tab-count {
          font-size: 11px; font-weight: 700;
          background: rgba(0,0,0,.07); border-radius: 10px; padding: 1px 7px;
        }
        .rec-tab.active .rec-tab-count { background: rgba(255,255,255,.2); }

        /* ── Cards ──────────────────────────────── */
        .rcard {
          background: #fff; border: 1px solid var(--border, #E3ECE8);
          border-radius: 12px; overflow: hidden;
          box-shadow: 0 1px 3px rgba(4,52,44,.04);
          transition: box-shadow .18s, transform .18s; margin-bottom: 12px;
        }
        .rcard:hover {
          box-shadow: 0 4px 16px rgba(4,52,44,.09); transform: translateY(-1px);
        }
        .rcard-inner { padding: 20px 22px; }

        .rcard-head {
          display: flex; align-items: center;
          justify-content: space-between; gap: 10px; margin-bottom: 8px;
        }
        .rcard-action-chip {
          display: inline-flex; align-items: center; gap: 5px;
          font-size: 11.5px; font-weight: 600; padding: 3px 9px;
          border-radius: 5px; background: var(--page-bg, #F2F8F5);
          color: var(--text-secondary, #5F6E68);
          border: 1px solid var(--border, #E3ECE8);
          white-space: nowrap; flex-shrink: 0;
        }
        .rcard-server-row {
          display: flex; align-items: center; gap: 10px;
          flex-wrap: wrap; margin-bottom: 10px;
        }
        .rcard-server-id {
          font-size: 20px; font-weight: 800;
          color: var(--text-primary, #1C2622); text-decoration: none;
          font-family: "SFMono-Regular", Consolas, monospace;
          letter-spacing: .02em; line-height: 1;
        }
        .rcard-server-id:hover { color: var(--accent-dark, #0F6E56); text-decoration: underline; }
        .rcard-server-type {
          font-size: 12px; color: var(--text-muted, #8A9691);
          background: var(--page-bg, #F2F8F5);
          border-radius: 6px; padding: 2px 8px; font-weight: 500;
        }
        .rcard-target-badge {
          font-size: 12px; font-weight: 600;
          color: var(--accent-dark, #0F6E56);
          background: var(--page-bg, #F2F8F5);
          border: 1px solid var(--border, #E3ECE8);
          border-radius: 6px; padding: 2px 9px;
        }
        .rcard-blocked-badge {
          font-size: 12px; font-weight: 600;
          color: var(--danger-text, #993C1D);
          background: var(--danger-bg, #FAECE7);
          border-radius: 6px; padding: 2px 9px;
        }
        .rcard-why {
          font-size: 14px; line-height: 1.65;
          color: var(--text-secondary, #5F6E68);
          margin: 0 0 16px; max-width: 640px;
        }

        /* ── Impact section ─────────────────────── */
        .rcard-impact {
          background: var(--page-bg, #F2F8F5);
          border-radius: 8px; padding: 12px 14px; margin-bottom: 16px;
        }
        .rcard-impact-header {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 8px;
        }
        .rcard-impact-label {
          font-size: 10.5px; font-weight: 700;
          text-transform: uppercase; letter-spacing: .06em;
          color: var(--text-muted, #8A9691);
        }
        .rcard-impact-info {
          position: relative; display: inline-flex; align-items: center;
        }
        .rcard-impact-info-icon {
          font-size: 12px; color: var(--text-muted, #8A9691);
          cursor: default; user-select: none; line-height: 1;
        }
        .rcard-impact-info-tooltip {
          display: none;
          position: absolute; right: 0; top: calc(100% + 6px);
          background: #fff; border: 1px solid var(--border, #E3ECE8);
          border-radius: 8px; padding: 10px 12px;
          font-size: 11.5px; color: var(--text-secondary, #5F6E68);
          line-height: 1.5; width: 280px; z-index: 20;
          box-shadow: 0 4px 16px rgba(4,52,44,.1);
          white-space: normal;
        }
        .rcard-impact-info:hover .rcard-impact-info-tooltip { display: block; }
        .rcard-impact-row {
          display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center;
        }
        .rcard-impact-chart { min-width: 0; }
        .rcard-impact-stats {
          display: flex; flex-direction: column; gap: 4px; align-items: flex-end;
        }
        .rcard-impact-stat {
          display: flex; align-items: baseline; gap: 3px;
        }
        .rcard-impact-stat-val {
          font-size: 14px; font-weight: 700;
          color: var(--text-primary, #1C2622);
        }
        .rcard-impact-stat-unit {
          font-size: 11px; color: var(--text-muted, #8A9691);
        }
        .rcard-impact-storage {
          display: flex; align-items: baseline; gap: 6px;
        }
        .rcard-impact-storage-val {
          font-size: 20px; font-weight: 700;
          color: var(--text-primary, #1C2622);
        }
        .rcard-impact-storage-sub {
          font-size: 12px; color: var(--text-muted, #8A9691);
        }

        /* ── Buttons ────────────────────────────── */
        .rcard-btns {
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        }
        .rcard-btn {
          border-radius: 8px; border: 1px solid; font-size: 13px;
          font-weight: 600; padding: 7px 15px; cursor: pointer; transition: all .15s;
        }
        .rcard-btn:disabled { opacity: .4; cursor: not-allowed; }
        .rcard-btn.accept {
          background: var(--accent-dark, #0F6E56);
          border-color: var(--accent-dark, #0F6E56); color: #fff;
        }
        .rcard-btn.accept:hover:not(:disabled) {
          background: var(--accent-darker, #04342C);
          border-color: var(--accent-darker, #04342C);
        }
        .rcard-btn.snooze {
          background: #fff; color: var(--text-secondary, #5F6E68);
          border-color: var(--border, #E3ECE8);
        }
        .rcard-btn.snooze:hover:not(:disabled) {
          background: var(--page-bg, #F2F8F5);
          border-color: var(--text-muted, #8A9691);
        }
        .rcard-btn.dismiss {
          background: #fff; color: var(--text-muted, #8A9691);
          border-color: var(--border, #E3ECE8);
        }
        .rcard-btn.dismiss:hover:not(:disabled) {
          background: var(--page-bg, #F2F8F5);
          border-color: var(--text-muted, #8A9691);
          color: var(--text-secondary, #5F6E68);
        }
        .rcard-detail-link {
          font-size: 12.5px; color: var(--text-muted, #8A9691);
          text-decoration: none; margin-left: auto; transition: color .15s;
        }
        .rcard-detail-link:hover { color: var(--accent-dark, #0F6E56); }

        /* ── Section divider ─────────────────────── */
        .rec-section-divider {
          display: flex; align-items: center; gap: 10px; margin: 22px 0 14px;
        }
        .rec-section-divider-label {
          font-size: 11.5px; font-weight: 700; text-transform: uppercase;
          letter-spacing: .07em; color: var(--text-muted, #8A9691); white-space: nowrap;
        }
        .rec-section-divider-line {
          flex: 1; height: 1px; background: var(--border, #E3ECE8);
        }
        .rec-section-divider-count {
          font-size: 11px; font-weight: 600; color: var(--text-muted, #8A9691);
          background: var(--page-bg, #F2F8F5); border: 1px solid var(--border, #E3ECE8);
          border-radius: 10px; padding: 1px 8px; white-space: nowrap;
        }

        /* ── Empty ──────────────────────────────── */
        .rec-empty {
          text-align: center; padding: 56px 24px; background: #fff;
          border: 1px solid var(--border, #E3ECE8); border-radius: 12px;
        }
        .rec-empty-blob { font-size: 44px; margin-bottom: 14px; }
        .rec-empty h3 { margin: 0 0 8px; font-size: 18px; color: var(--text-primary); }
        .rec-empty p  { margin: 0 auto; font-size: 14px; color: var(--text-secondary); max-width: 380px; line-height: 1.6; }

        /* ── Toast ──────────────────────────────── */
        .rec-toast {
          position: fixed; bottom: 28px; right: 28px;
          background: var(--accent-darker, #04342C); color: #fff;
          padding: 12px 20px; border-radius: 10px; font-size: 14px; font-weight: 500;
          box-shadow: 0 8px 24px rgba(4,52,44,.22);
          animation: toastIn .22s cubic-bezier(.22,1,.36,1); z-index: 300;
        }
        @keyframes toastIn {
          from { opacity: 0; transform: translateY(10px) scale(.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }

        /* ── Footer ─────────────────────────────── */
        .rec-footnote {
          text-align: center; font-size: 12.5px; color: var(--text-muted, #8A9691);
          margin-top: 20px; padding-top: 16px;
          border-top: 1px solid var(--border, #E3ECE8);
        }
        .rec-footnote a { color: var(--accent-dark, #0F6E56); text-decoration: none; }
        .rec-footnote a:hover { text-decoration: underline; }

        @media (max-width: 900px) {
          .rec-layout { grid-template-columns: 1fr; }
          .rec-sidebar { position: static; }
        }
        @media (max-width: 620px) {
          .rec-header { flex-direction: column; align-items: flex-start; gap: 12px; }
          .rcard-inner { padding: 16px; }
          .rcard-server-id { font-size: 17px; }
          .rcard-why { font-size: 13.5px; }
          .rcard-detail-link { margin-left: 0; }
          .rcard-impact-row { grid-template-columns: 1fr; }
          .rcard-impact-stats { flex-direction: row; align-items: center; }
        }      `}</style>

      <div className="rec-page">

        {/* Header */}
        <div className="rec-header">
          <div className="rec-header-title">
            <h1>Recommendations</h1>
            <p>Active optimisation targets from continuous telemetry monitoring.</p>
          </div>
          <button className="rec-refresh-btn" onClick={load} disabled={loading}>
            {loading ? "↻ Loading…" : "↻ Refresh"}
          </button>
        </div>

        {/* Summary strip — stat cards */}
        {!loading && recs.length > 0 && (
          <div className="rec-summary-strip">
            {/* Total pending */}
            <div className="rec-stat-card">
              <span className="rec-stat-label">Pending</span>
              <span className="rec-stat-value">{counts.all}</span>
              <span className="rec-stat-sub">recommendations</span>
            </div>
            {/* Priority breakdown */}
            <div className="rec-stat-card">
              <span className="rec-stat-label">Risk level</span>
              <span className="rec-stat-value" style={{
                color: recs.filter(r => r.priority === "high").length > 0 ? "#E24B4A"
                  : recs.filter(r => r.priority === "medium").length > 0 ? "#D97706"
                  : "#1D9E75"
              }}>
                {recs.filter(r => r.priority === "high").length > 0 ? "High"
                  : recs.filter(r => r.priority === "medium").length > 0 ? "Moderate"
                  : "Low"}
              </span>
              <span className="rec-stat-sub">highest active priority</span>
            </div>
            {/* Idle servers */}
            {counts.consolidate > 0 && (
              <div className="rec-stat-card">
                <span className="rec-stat-label">Idle servers</span>
                <span className="rec-stat-value">{counts.consolidate}</span>
                <span className="rec-stat-sub">consolidation {counts.consolidate === 1 ? "candidate" : "candidates"}</span>
              </div>
            )}
            {/* Storage issues */}
            {counts.storage > 0 && (
              <div className="rec-stat-card">
                <span className="rec-stat-label">Storage</span>
                <span className="rec-stat-value">{counts.storage}</span>
                <span className="rec-stat-sub">{counts.storage === 1 ? "issue" : "issues"} flagged</span>
              </div>
            )}
          </div>
        )}

        {error && <div className="error-banner" style={{ marginBottom: 20 }}>{error}</div>}

        {/* Two-column split */}
        <div className="rec-layout">
          <div className="rec-main">
            {/* Filter tabs */}
            {recs.length > 0 && (
              <div className="rec-tabs">
                {[
                  { key: "all",         label: "All",          count: counts.all },
                  { key: "consolidate", label: "Idle servers", count: counts.consolidate },
                  { key: "storage",     label: "Storage",      count: counts.storage },
                ].map((t) => (
                  <button
                    key={t.key}
                    className={`rec-tab ${filter === t.key ? "active" : ""}`}
                    onClick={() => setFilter(t.key)}
                  >
                    {t.label}
                    <span className="rec-tab-count">{t.count}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Card list */}
            {loading && recs.length === 0 ? (
              <div className="rec-empty">
                <div className="rec-empty-blob">⏳</div>
                <h3>Loading…</h3>
                <p>Fetching recommendations from the backend.</p>
              </div>
            ) : sorted.length === 0 ? (
              <EmptyState filtered={sorted.length} total={recs.length} />
            ) : filter === "all" ? (
              <>
                {consolidateGroup.length > 0 && (
                  <>
                    <div className="rec-section-divider">
                      <span className="rec-section-divider-label">Idle servers</span>
                      <div className="rec-section-divider-line" />
                      <span className="rec-section-divider-count">{consolidateGroup.length}</span>
                    </div>
                    {consolidateGroup.map((rec) => (
                      <RecCard key={rec.id} rec={rec} onAction={handleAction} actLoading={actLoading} canDecide={canDecide} />
                    ))}
                  </>
                )}
                {storageGroup.length > 0 && (
                  <>
                    <div className="rec-section-divider">
                      <span className="rec-section-divider-label">Storage</span>
                      <div className="rec-section-divider-line" />
                      <span className="rec-section-divider-count">{storageGroup.length}</span>
                    </div>
                    {storageGroup.map((rec) => (
                      <RecCard key={rec.id} rec={rec} onAction={handleAction} actLoading={actLoading} canDecide={canDecide} />
                    ))}
                  </>
                )}
              </>
            ) : (
              sorted.map((rec) => (
                <RecCard key={rec.id} rec={rec} onAction={handleAction} actLoading={actLoading} canDecide={canDecide} />
              ))
            )}
          </div>

          {/* Sidebar */}
          {!loading && <RecSidebar recs={recs} />}
        </div>
      </div>

      {toast && <div className="rec-toast">{toast}</div>}
    </>
  );
}
