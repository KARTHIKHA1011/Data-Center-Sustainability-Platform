import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import api from "../api";
import { useAuth } from "../AuthContext";

/* ─── Helpers ─────────────────────────────────────────────────── */

const ACTION_LABEL = {
  consolidate:  "Workload consolidation",
  rightsize:    "Storage right-sizing",
  archive:      "Archive to cold storage",
  deduplicate:  "Deduplication",
};

function fmt(v, dp = 2) {
  return v == null || v === 0 ? null : Number(v).toFixed(dp);
}

function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso + (iso.endsWith("Z") ? "" : "Z"))) / 1000);
  if (diff < 60)   return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/* ─── Single action row ───────────────────────────────────────── */

function ActionRow({ row, onMarkExecuted, onDismiss, canDecide }) {
  const [busy,  setBusy]  = useState(false);
  const [note,  setNote]  = useState(row.execution_note || "");
  const [editingNote, setEditingNote] = useState(false);

  const handle = async (fn) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };

  const energy  = fmt(row.estimated_energy_saving_kwh, 2);
  const carbon  = fmt(row.estimated_carbon_reduction_kg, 2);
  const cost    = fmt(row.estimated_cost_saving, 0);
  const storage = fmt(row.estimated_storage_reclaimed_gb, 1);
  const isExecuted = !!row.executed_at;

  return (
    <div className={`aa-row ${isExecuted ? "executed" : "pending-exec"}`}>
      {/* Status stripe */}
      <div className={`aa-stripe ${isExecuted ? "done" : ""}`} />

      <div className="aa-body">
        {/* Header */}
        <div className="aa-row-head">
          <div className="aa-row-meta">
            <span className="aa-action-label">{ACTION_LABEL[row.action] || row.action}</span>
            <span className="aa-time">{timeAgo(row.created_at)}</span>
          </div>
          <span className={`aa-status-badge ${isExecuted ? "done" : ""}`}>
            {isExecuted ? "✓ Executed" : "Awaiting execution"}
          </span>
        </div>

        {/* Server info */}
        <div className="aa-server-row">
          <Link to={`/servers/${row.server_id}`} className="aa-server-id">{row.server_id}</Link>
          {row.target_server_id && (
            <span className="aa-arrow">→</span>
          )}
          {row.target_server_id && (
            <Link to={`/servers/${row.target_server_id}`} className="aa-server-id">{row.target_server_id}</Link>
          )}
        </div>

        {/* Estimated impact chips */}
        {(energy || carbon || cost || storage) && (
          <div className="aa-impact-chips">
            <span className="aa-chip-label">Est. savings at decision time:</span>
            {energy  && <span className="aa-chip">{energy} kWh</span>}
            {carbon  && <span className="aa-chip">{carbon} kg CO₂</span>}
            {cost    && <span className="aa-chip">₹{cost}</span>}
            {storage && <span className="aa-chip">{storage} GB freed</span>}
          </div>
        )}

        {/* Approved by — audit trail */}
        {row.decided_by_name && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
            Approved by: <strong style={{ color: "var(--text-secondary)" }}>{row.decided_by_name}</strong>
          </div>
        )}

        {/* Execution note */}
        {isExecuted && (
          <div className="aa-exec-detail">
            <span className="aa-exec-when">
              Marked executed {timeAgo(row.executed_at)}
              {row.execution_note && " · "}
            </span>
            {editingNote ? (
              <div className="aa-note-edit">
                <input
                  className="aa-note-input"
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="Add a note about what was done…"
                  maxLength={200}
                />
                <button
                  className="aa-note-save"
                  disabled={busy}
                  onClick={() => handle(async () => {
                    await api.operatorActionUpdate(row.id, { execution_note: note });
                    onMarkExecuted(row.id, true, note);
                    setEditingNote(false);
                  })}
                >
                  Save
                </button>
                <button className="aa-note-cancel" onClick={() => setEditingNote(false)}>Cancel</button>
              </div>
            ) : (
              <span
                className="aa-note-text"
                onClick={() => setEditingNote(true)}
                title="Click to edit note"
              >
                {row.execution_note || <span className="aa-note-placeholder">Add execution note…</span>}
              </span>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="aa-actions">
          {canDecide ? (
            <>
              {!isExecuted && (
                <button
                  className="aa-btn primary"
                  disabled={busy}
                  onClick={() => handle(async () => {
                    await api.operatorActionUpdate(row.id, { executed: true });
                    onMarkExecuted(row.id, true, null);
                  })}
                >
                  ✓ Mark as executed
                </button>
              )}
              {isExecuted && (
                <button
                  className="aa-btn secondary"
                  disabled={busy}
                  onClick={() => handle(async () => {
                    await api.operatorActionUpdate(row.id, { executed: false });
                    onMarkExecuted(row.id, false, null);
                  })}
                >
                  Undo execution
                </button>
              )}
              <button
                className="aa-btn ghost"
                disabled={busy}
                onClick={() => handle(() => onDismiss(row.id))}
              >
                Remove from log
              </button>
            </>
          ) : (
            <span style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
              View only — marking as executed requires Infrastructure Manager role
            </span>
          )}
          <Link to={`/recommendations/${row.recommendation_id}`} className="aa-detail-link">
            View original analysis →
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ─── Main page ───────────────────────────────────────────────── */

export default function ApprovedActions() {
  const [actions,  setActions]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState("");
  const [filter,   setFilter]   = useState("all"); // all | pending | executed

  const { user } = useAuth();
  // Both infrastructure_manager and operations_engineer can mark actions as executed.
  // Only infrastructure_manager can approve/reject/snooze recommendations (enforced separately).
  const canMarkExecuted = user?.role === "infrastructure_manager" || user?.role === "operations_engineer";

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const res = await api.operatorActions(200);
      // Only show approve-type actions (not snooze / do_nothing)
      const approved = (res.data || []).filter(a =>
        ["consolidate", "rightsize", "archive", "deduplicate"].includes(a.action)
      );
      setActions(approved);
    } catch {
      setError("Failed to load approved actions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleMarkExecuted = useCallback((id, executed, note) => {
    setActions(prev => prev.map(a =>
      a.id === id
        ? { ...a, executed_at: executed ? new Date().toISOString() : null, execution_note: note ?? a.execution_note }
        : a
    ));
  }, []);

  const handleDismiss = useCallback(async (id) => {
    // There's no delete endpoint — we just hide it from the UI locally
    setActions(prev => prev.filter(a => a.id !== id));
  }, []);

  const shown = filter === "all" ? actions
    : filter === "pending"  ? actions.filter(a => !a.executed_at)
    : actions.filter(a => !!a.executed_at);

  const pendingCount  = actions.filter(a => !a.executed_at).length;
  const executedCount = actions.filter(a => !!a.executed_at).length;

  // Aggregate estimated savings for executed actions
  const executedSavings = actions
    .filter(a => !!a.executed_at)
    .reduce((s, a) => ({
      energy:  s.energy  + (a.estimated_energy_saving_kwh    || 0),
      carbon:  s.carbon  + (a.estimated_carbon_reduction_kg  || 0),
      cost:    s.cost    + (a.estimated_cost_saving          || 0),
      storage: s.storage + (a.estimated_storage_reclaimed_gb || 0),
    }), { energy: 0, carbon: 0, cost: 0, storage: 0 });

  return (
    <>
      <style>{`
        .aa-page { max-width: 1100px; }

        /* ── Header ─────────────────────────────── */
        .aa-header {
          display: flex; justify-content: space-between; align-items: flex-end;
          margin-bottom: 20px;
        }
        .aa-header h1 {
          font-size: 24px; font-weight: 700; color: var(--text-primary); margin: 0 0 4px;
        }
        .aa-header p {
          font-size: 13.5px; color: var(--text-secondary); margin: 0;
        }
        .aa-refresh-btn {
          border: 1px solid var(--border); background: #fff;
          color: var(--text-secondary); border-radius: 8px;
          padding: 7px 14px; font-size: 12.5px; font-weight: 600;
          cursor: pointer; transition: background .15s;
        }
        .aa-refresh-btn:hover { background: var(--page-bg); color: var(--accent-dark); border-color: var(--accent); }

        /* ── Stats strip ─────────────────────────── */
        .aa-stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px,1fr));
          gap: 0;
          background: #fff;
          border: 1px solid var(--border); border-radius: 12px;
          margin-bottom: 20px; overflow: hidden;
          box-shadow: 0 1px 3px rgba(4,52,44,.04);
        }
        .aa-stat {
          padding: 16px 20px;
          border-right: 1px solid var(--border);
        }
        .aa-stat:last-child { border-right: none; }
        .aa-stat-label {
          font-size: 11px; font-weight: 700; text-transform: uppercase;
          letter-spacing: .06em; color: var(--text-muted); margin-bottom: 4px;
        }
        .aa-stat-value {
          font-size: 24px; font-weight: 700; color: var(--text-primary); line-height: 1;
        }
        .aa-stat-sub { font-size: 11.5px; color: var(--text-secondary); margin-top: 3px; }

        /* ── Filter tabs ─────────────────────────── */
        .aa-tabs {
          display: flex; gap: 4px; margin-bottom: 20px;
          background: #fff; border: 1px solid var(--border);
          border-radius: 8px; padding: 3px; width: fit-content;
        }
        .aa-tab {
          border: none; background: transparent; border-radius: 6px;
          padding: 7px 16px; font-size: 12.5px; font-weight: 600;
          color: var(--text-secondary); cursor: pointer; transition: all .15s;
          display: flex; align-items: center; gap: 6px;
        }
        .aa-tab:hover { color: var(--text-primary); }
        .aa-tab.active { background: var(--accent-dark); color: #fff; }
        .aa-tab-count {
          font-size: 11px; font-weight: 700;
          background: rgba(0,0,0,.07); border-radius: 10px; padding: 1px 7px;
        }
        .aa-tab.active .aa-tab-count { background: rgba(255,255,255,.2); }

        /* ── Action rows ─────────────────────────── */
        .aa-row {
          display: flex; background: #fff;
          border: 1px solid var(--border); border-radius: 12px;
          overflow: hidden; margin-bottom: 12px;
          box-shadow: 0 1px 3px rgba(4,52,44,.04);
          transition: box-shadow .18s;
        }
        .aa-row:hover { box-shadow: 0 4px 14px rgba(4,52,44,.08); }
        .aa-row.executed { opacity: .88; }

        .aa-stripe { width: 4px; flex-shrink: 0; background: var(--accent-dark); }
        .aa-stripe.done { background: var(--border); }

        .aa-body { flex: 1; padding: 18px 20px; }

        .aa-row-head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 12px; margin-bottom: 8px;
        }
        .aa-row-meta { display: flex; align-items: center; gap: 10px; }
        .aa-action-label {
          font-size: 12px; font-weight: 600; color: var(--text-secondary);
          background: var(--page-bg); border: 1px solid var(--border);
          border-radius: 5px; padding: 3px 9px;
        }
        .aa-time { font-size: 11.5px; color: var(--text-muted); }
        .aa-status-badge {
          font-size: 11.5px; font-weight: 700; padding: 4px 10px; border-radius: 20px;
          background: #EDF7F2; color: var(--accent-dark); white-space: nowrap;
        }
        .aa-status-badge.done { background: var(--page-bg); color: var(--text-muted); }

        .aa-server-row {
          display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
        }
        .aa-server-id {
          font-size: 20px; font-weight: 800; color: var(--text-primary);
          font-family: "SFMono-Regular", Consolas, monospace;
          text-decoration: none; letter-spacing: .02em;
        }
        .aa-server-id:hover { color: var(--accent-dark); text-decoration: underline; }
        .aa-arrow { font-size: 16px; color: var(--text-muted); }

        .aa-impact-chips {
          display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px;
        }
        .aa-chip-label {
          font-size: 11px; font-weight: 600; text-transform: uppercase;
          letter-spacing: .05em; color: var(--text-muted); margin-right: 2px;
        }
        .aa-chip {
          font-size: 12px; font-weight: 600; padding: 3px 9px;
          background: var(--page-bg); border: 1px solid var(--border);
          border-radius: 6px; color: var(--text-primary);
        }

        .aa-exec-detail {
          font-size: 12px; color: var(--text-muted); margin-bottom: 12px;
          display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        }
        .aa-exec-when { color: var(--text-muted); }
        .aa-note-text {
          color: var(--text-secondary); cursor: pointer; text-decoration: underline dotted;
        }
        .aa-note-placeholder { color: var(--text-muted); font-style: italic; }
        .aa-note-edit { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .aa-note-input {
          border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px;
          font-size: 12px; width: 260px; outline: none;
        }
        .aa-note-input:focus { border-color: var(--accent); }
        .aa-note-save {
          background: var(--accent-dark); color: #fff; border: none;
          border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
        }
        .aa-note-cancel {
          background: none; border: none; font-size: 12px;
          color: var(--text-muted); cursor: pointer;
        }

        .aa-actions {
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
          padding-top: 12px; border-top: 1px solid var(--border);
        }
        .aa-btn {
          border-radius: 8px; border: 1px solid; font-size: 13px; font-weight: 600;
          padding: 7px 15px; cursor: pointer; transition: all .15s;
        }
        .aa-btn:disabled { opacity: .4; cursor: not-allowed; }
        .aa-btn.primary {
          background: var(--accent-dark); border-color: var(--accent-dark); color: #fff;
        }
        .aa-btn.primary:hover:not(:disabled) { background: var(--accent-darker); }
        .aa-btn.secondary {
          background: #fff; color: var(--text-secondary); border-color: var(--border);
        }
        .aa-btn.secondary:hover:not(:disabled) { background: var(--page-bg); }
        .aa-btn.ghost {
          background: #fff; color: var(--text-muted); border-color: var(--border);
        }
        .aa-btn.ghost:hover:not(:disabled) {
          background: var(--danger-bg); color: var(--danger-text); border-color: var(--danger-text);
        }
        .aa-detail-link {
          font-size: 12.5px; color: var(--text-muted); text-decoration: none;
          margin-left: auto; transition: color .15s;
        }
        .aa-detail-link:hover { color: var(--accent-dark); }

        /* ── Empty ──────────────────────────────── */
        .aa-empty {
          text-align: center; padding: 56px 24px; background: #fff;
          border: 1px solid var(--border); border-radius: 12px;
        }
        .aa-empty-icon { font-size: 44px; margin-bottom: 14px; }
        .aa-empty h3 { margin: 0 0 8px; font-size: 18px; color: var(--text-primary); }
        .aa-empty p { margin: 0 auto; font-size: 14px; color: var(--text-secondary); max-width: 360px; line-height: 1.6; }
        .aa-empty a { color: var(--accent-dark); text-decoration: none; }
        .aa-empty a:hover { text-decoration: underline; }

        @media (max-width: 640px) {
          .aa-header { flex-direction: column; align-items: flex-start; gap: 12px; }
          .aa-body { padding: 14px 16px; }
          .aa-server-id { font-size: 16px; }
          .aa-detail-link { margin-left: 0; }
        }
      `}</style>

      <div className="aa-page">
        {/* Header */}
        <div className="aa-header">
          <div>
            <h1>Approved Actions</h1>
            <p>Recommendations that have been approved — mark each one as executed once the action is complete.</p>
          </div>
          <button className="aa-refresh-btn" onClick={load} disabled={loading}>
            {loading ? "↻ Loading…" : "↻ Refresh"}
          </button>
        </div>

        {/* Stats strip */}
        {!loading && actions.length > 0 && (
          <div className="aa-stats">
            <div className="aa-stat">
              <div className="aa-stat-label">Approved</div>
              <div className="aa-stat-value">{actions.length}</div>
              <div className="aa-stat-sub">total decisions</div>
            </div>
            <div className="aa-stat">
              <div className="aa-stat-label">Awaiting execution</div>
              <div className="aa-stat-value" style={{ color: pendingCount > 0 ? "#D97706" : "var(--text-primary)" }}>
                {pendingCount}
              </div>
              <div className="aa-stat-sub">not yet confirmed</div>
            </div>
            <div className="aa-stat">
              <div className="aa-stat-label">Executed</div>
              <div className="aa-stat-value" style={{ color: executedCount > 0 ? "#1D9E75" : "var(--text-primary)" }}>
                {executedCount}
              </div>
              <div className="aa-stat-sub">confirmed complete</div>
            </div>
            {executedSavings.energy > 0 && (
              <div className="aa-stat">
                <div className="aa-stat-label">Energy (executed)</div>
                <div className="aa-stat-value">{executedSavings.energy.toFixed(1)}</div>
                <div className="aa-stat-sub">kWh estimated saved</div>
              </div>
            )}
            {executedSavings.cost > 0 && (
              <div className="aa-stat">
                <div className="aa-stat-label">Cost (executed)</div>
                <div className="aa-stat-value">₹{executedSavings.cost.toFixed(0)}</div>
                <div className="aa-stat-sub">estimated saving</div>
              </div>
            )}
          </div>
        )}

        {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

        {/* Filter tabs */}
        {actions.length > 0 && (
          <div className="aa-tabs">
            {[
              { key: "all",      label: "All",               count: actions.length },
              { key: "pending",  label: "Awaiting execution", count: pendingCount },
              { key: "executed", label: "Executed",           count: executedCount },
            ].map(t => (
              <button
                key={t.key}
                className={`aa-tab ${filter === t.key ? "active" : ""}`}
                onClick={() => setFilter(t.key)}
              >
                {t.label}
                <span className="aa-tab-count">{t.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="aa-empty">
            <div className="aa-empty-icon">⏳</div>
            <h3>Loading…</h3>
            <p>Fetching approved actions from the backend.</p>
          </div>
        ) : shown.length === 0 ? (
          <div className="aa-empty">
            <div className="aa-empty-icon">{filter === "executed" ? "✓" : "📋"}</div>
            <h3>
              {filter === "executed" ? "No executed actions yet"
                : filter === "pending" ? "All actions executed"
                : "No approved actions yet"}
            </h3>
            <p>
              {filter === "all"
                ? <>Approve recommendations from the <Link to="/recommendations">Recommendations</Link> page to see them here.</>
                : filter === "pending"
                  ? "Every approved action has been marked as executed."
                  : "Mark approved actions as executed once the work is done."}
            </p>
          </div>
        ) : (
          shown.map(row => (
            <ActionRow
              key={row.id}
              row={row}
              onMarkExecuted={handleMarkExecuted}
              onDismiss={handleDismiss}
              canDecide={canMarkExecuted}
            />
          ))
        )}

        {/* Note */}
        {actions.length > 0 && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 16, textAlign: "center" }}>
            Impact figures are estimates captured at decision time. Marking as executed confirms the action was carried out — GreenOps cannot verify this automatically.
          </p>
        )}
      </div>
    </>
  );
}
