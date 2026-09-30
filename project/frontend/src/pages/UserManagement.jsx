import { useEffect, useState, useCallback } from "react";
import api from "../api";

/* ─── Role metadata ───────────────────────────────────────────── */

const ROLES = [
  { value: "infrastructure_manager", label: "Infrastructure Manager" },
  { value: "sustainability_manager",  label: "Sustainability Manager" },
  { value: "operations_engineer",     label: "Operations Engineer" },
];

const ROLE_LABEL = Object.fromEntries(ROLES.map(r => [r.value, r.label]));

const ROLE_BADGE_CLS = {
  infrastructure_manager: "good",
  sustainability_manager:  "warn",
  operations_engineer:     "neutral",
};

/* ─── Permissions matrix ──────────────────────────────────────── */

const PERMISSION_MATRIX = [
  {
    page: "Overview",
    infrastructure_manager: true,
    sustainability_manager: true,
    operations_engineer: true,
  },
  {
    page: "Servers",
    infrastructure_manager: true,
    sustainability_manager: false,
    operations_engineer: true,
  },
  {
    page: "Storage",
    infrastructure_manager: true,
    sustainability_manager: false,
    operations_engineer: true,
  },
  {
    page: "Analytics",
    infrastructure_manager: true,
    sustainability_manager: true,
    operations_engineer: true,
  },
  {
    page: "Recommendations (view)",
    infrastructure_manager: true,
    sustainability_manager: true,
    operations_engineer: true,
  },
  {
    page: "Approve / Reject / Snooze",
    infrastructure_manager: true,
    sustainability_manager: false,
    operations_engineer: false,
  },
  {
    page: "Approved Actions (view)",
    infrastructure_manager: true,
    sustainability_manager: false,
    operations_engineer: true,
  },
  {
    page: "Mark action as executed",
    infrastructure_manager: true,
    sustainability_manager: false,
    operations_engineer: true,
  },
  {
    page: "ESG Report",
    infrastructure_manager: true,
    sustainability_manager: true,
    operations_engineer: false,
  },
  {
    page: "Preferences (view)",
    infrastructure_manager: true,
    sustainability_manager: true,
    operations_engineer: true,
  },
  {
    page: "Edit recommendation weights",
    infrastructure_manager: true,
    sustainability_manager: false,
    operations_engineer: false,
  },
  {
    page: "User Management",
    infrastructure_manager: true,
    sustainability_manager: false,
    operations_engineer: false,
  },
];

/* ─── Helpers ─────────────────────────────────────────────────── */

function timeAgo(iso) {
  if (!iso) return "—";
  const diff = Math.floor(
    (Date.now() - new Date(iso.endsWith("Z") ? iso : `${iso}Z`)) / 1000
  );
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso.endsWith("Z") ? iso : `${iso}Z`).toLocaleDateString([], {
    month: "short", day: "numeric", year: "numeric",
  });
}

const EMPTY_FORM = {
  employee_id: "",
  name: "",
  email: "",
  password: "",
  role: "operations_engineer",
  is_active: true,
};

/* ─── Add / Edit modal ────────────────────────────────────────── */

function UserFormModal({ existing, onSave, onClose, saving, error }) {
  const isEdit = !!existing;
  const [form, setForm] = useState(
    isEdit
      ? {
          employee_id: existing.employee_id || "",
          name: existing.name || "",
          email: existing.email || "",
          password: "",
          role: existing.role || "operations_engineer",
          is_active: existing.is_active ?? true,
        }
      : { ...EMPTY_FORM }
  );

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  return (
    <div className="um-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="um-modal">
        <div className="um-modal-header">
          <h2 className="um-modal-title">{isEdit ? "Edit user" : "Add new user"}</h2>
          <button className="um-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {error && <div className="um-modal-error">{error}</div>}

        <div className="um-form-grid">
          <div className="um-form-field">
            <label className="um-label">Employee ID <span className="um-optional">(optional)</span></label>
            <input
              className="um-input"
              placeholder="e.g. EMP-001"
              value={form.employee_id}
              onChange={e => set("employee_id", e.target.value)}
            />
          </div>

          <div className="um-form-field">
            <label className="um-label">Full name <span className="um-required">*</span></label>
            <input
              className="um-input"
              placeholder="e.g. Arjun Mehta"
              value={form.name}
              onChange={e => set("name", e.target.value)}
            />
          </div>

          <div className="um-form-field">
            <label className="um-label">Email address <span className="um-required">*</span></label>
            <input
              className="um-input"
              type="email"
              placeholder="user@company.com"
              value={form.email}
              onChange={e => set("email", e.target.value)}
            />
          </div>

          <div className="um-form-field">
            <label className="um-label">
              Password {isEdit && <span className="um-optional">(leave blank to keep current)</span>}
              {!isEdit && <span className="um-required">*</span>}
            </label>
            <input
              className="um-input"
              type="password"
              placeholder={isEdit ? "Enter new password to change" : "Min 6 characters"}
              value={form.password}
              onChange={e => set("password", e.target.value)}
              autoComplete="new-password"
            />
          </div>

          <div className="um-form-field">
            <label className="um-label">Role <span className="um-required">*</span></label>
            <select
              className="um-input um-select"
              value={form.role}
              onChange={e => set("role", e.target.value)}
            >
              {ROLES.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>

          {isEdit && (
            <div className="um-form-field um-checkbox-field">
              <label className="um-checkbox-label">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={e => set("is_active", e.target.checked)}
                  className="um-checkbox"
                />
                Account active
              </label>
            </div>
          )}
        </div>

        <div className="um-modal-footer">
          <button className="um-btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="um-btn-primary"
            disabled={saving}
            onClick={() => onSave(form, isEdit)}
          >
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create user"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Main page ───────────────────────────────────────────────── */

export default function UserManagement() {
  const [users,    setUsers]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState("");
  const [toast,    setToast]    = useState("");
  const [modal,    setModal]    = useState(null);  // null | "add" | {user}
  const [saving,   setSaving]   = useState(false);
  const [formErr,  setFormErr]  = useState("");
  const [tab,      setTab]      = useState("users"); // "users" | "permissions"
  const [confirmDeactivate, setConfirmDeactivate] = useState(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const res = await api.listUsers();
      setUsers(res.data || []);
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to load users.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (form, isEdit) => {
    setFormErr("");
    if (!form.name.trim()) { setFormErr("Name is required."); return; }
    if (!form.email.trim()) { setFormErr("Email is required."); return; }
    if (!isEdit && !form.password) { setFormErr("Password is required for new users."); return; }
    if (form.password && form.password.length < 6) { setFormErr("Password must be at least 6 characters."); return; }

    try {
      setSaving(true);
      const payload = {
        employee_id: form.employee_id.trim() || null,
        name: form.name.trim(),
        email: form.email.trim(),
        role: form.role,
        is_active: form.is_active,
      };
      if (form.password) payload.password = form.password;

      if (isEdit) {
        await api.updateUser(modal.id, payload);
        showToast(`${form.name} updated.`);
      } else {
        payload.password = form.password;
        await api.createUser(payload);
        showToast(`${form.name} added successfully.`);
      }
      setModal(null);
      load();
    } catch (e) {
      setFormErr(e.response?.data?.detail || "Failed to save user.");
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async (user) => {
    try {
      await api.deactivateUser(user.id);
      showToast(`${user.name} deactivated.`);
      setConfirmDeactivate(null);
      load();
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to deactivate user.");
    }
  };

  const handleReactivate = async (user) => {
    try {
      await api.updateUser(user.id, { is_active: true });
      showToast(`${user.name} reactivated.`);
      load();
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to reactivate user.");
    }
  };

  const activeUsers   = users.filter(u => u.is_active);
  const inactiveUsers = users.filter(u => !u.is_active);

  return (
    <>
      <style>{`
        .um-page { max-width: 1100px; }

        /* ── Header ──────────────────────────────── */
        .um-header {
          display: flex; justify-content: space-between; align-items: flex-end;
          margin-bottom: 20px; gap: 16px;
        }
        .um-header h1 {
          font-size: 24px; font-weight: 700; color: var(--text-primary); margin: 0 0 4px;
        }
        .um-header p {
          font-size: 13.5px; color: var(--text-secondary); margin: 0;
        }

        /* ── Tabs ────────────────────────────────── */
        .um-tabs {
          display: flex; gap: 4px; margin-bottom: 24px;
          background: #fff; border: 1px solid var(--border);
          border-radius: 8px; padding: 3px; width: fit-content;
        }
        .um-tab {
          border: none; background: transparent; border-radius: 6px;
          padding: 7px 16px; font-size: 12.5px; font-weight: 600;
          color: var(--text-secondary); cursor: pointer; transition: all .15s;
        }
        .um-tab:hover { color: var(--text-primary); }
        .um-tab.active { background: var(--accent-dark); color: #fff; }

        /* ── Stats strip ─────────────────────────── */
        .um-stats {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr));
          background: #fff; border: 1px solid var(--border); border-radius: 12px;
          margin-bottom: 20px; overflow: hidden;
          box-shadow: 0 1px 3px rgba(4,52,44,.04);
        }
        .um-stat {
          padding: 16px 20px; border-right: 1px solid var(--border);
        }
        .um-stat:last-child { border-right: none; }
        .um-stat-label {
          font-size: 11px; font-weight: 700; text-transform: uppercase;
          letter-spacing: .06em; color: var(--text-muted); margin-bottom: 4px;
        }
        .um-stat-value {
          font-size: 26px; font-weight: 700; color: var(--text-primary); line-height: 1;
        }

        /* ── Table ───────────────────────────────── */
        .um-table-wrap {
          background: #fff; border: 1px solid var(--border); border-radius: 12px;
          overflow: hidden; box-shadow: 0 1px 3px rgba(4,52,44,.04); margin-bottom: 20px;
        }
        .um-table-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 16px 20px; border-bottom: 1px solid var(--border);
        }
        .um-table-title {
          font-size: 14px; font-weight: 700; color: var(--text-primary); margin: 0;
        }
        .um-table { width: 100%; border-collapse: collapse; }
        .um-table th {
          text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase;
          letter-spacing: .06em; color: var(--text-muted);
          padding: 12px 20px; background: var(--page-bg);
          border-bottom: 1px solid var(--border);
        }
        .um-table td {
          padding: 14px 20px; font-size: 13.5px; color: var(--text-primary);
          border-bottom: 1px solid var(--border); vertical-align: middle;
        }
        .um-table tr:last-child td { border-bottom: none; }
        .um-table tr:hover td { background: #FAFCFB; }

        .um-emp-id {
          font-family: "SFMono-Regular", Consolas, monospace;
          font-size: 12px; color: var(--text-muted);
          background: var(--page-bg); border-radius: 5px; padding: 2px 7px;
        }
        .um-name { font-weight: 600; color: var(--text-primary); }
        .um-email { font-size: 12.5px; color: var(--text-secondary); margin-top: 2px; }

        .um-inactive-row td { opacity: .55; }

        /* ── Row actions ─────────────────────────── */
        .um-row-actions { display: flex; align-items: center; gap: 6px; }
        .um-row-btn {
          border-radius: 6px; border: 1px solid; font-size: 12px; font-weight: 600;
          padding: 5px 11px; cursor: pointer; transition: all .15s; white-space: nowrap;
        }
        .um-row-btn.edit {
          background: #fff; color: var(--text-secondary); border-color: var(--border);
        }
        .um-row-btn.edit:hover { background: var(--page-bg); border-color: var(--accent); color: var(--accent-dark); }
        .um-row-btn.deactivate {
          background: #fff; color: var(--danger-text); border-color: #F5C4B5;
        }
        .um-row-btn.deactivate:hover { background: var(--danger-bg); }
        .um-row-btn.reactivate {
          background: #fff; color: var(--accent-dark); border-color: var(--border);
        }
        .um-row-btn.reactivate:hover { background: var(--success-bg); border-color: var(--accent); }

        /* ── Add button ──────────────────────────── */
        .um-add-btn {
          display: inline-flex; align-items: center; gap: 6px;
          background: var(--accent-dark); color: #fff; border: none;
          border-radius: 8px; padding: 9px 16px; font-size: 13px; font-weight: 600;
          cursor: pointer; transition: background .15s; white-space: nowrap;
        }
        .um-add-btn:hover { background: var(--sidebar-bg); }

        /* ── Permissions matrix ──────────────────── */
        .um-matrix-wrap {
          background: #fff; border: 1px solid var(--border); border-radius: 12px;
          overflow: hidden; box-shadow: 0 1px 3px rgba(4,52,44,.04);
        }
        .um-matrix-header {
          padding: 16px 20px; border-bottom: 1px solid var(--border);
        }
        .um-matrix-title {
          font-size: 14px; font-weight: 700; color: var(--text-primary); margin: 0 0 4px;
        }
        .um-matrix-sub {
          font-size: 12.5px; color: var(--text-secondary); margin: 0;
        }
        .um-matrix { width: 100%; border-collapse: collapse; }
        .um-matrix th {
          text-align: center; font-size: 12px; font-weight: 700;
          color: var(--text-secondary); padding: 14px 18px;
          background: var(--page-bg); border-bottom: 1px solid var(--border);
        }
        .um-matrix th:first-child { text-align: left; }
        .um-matrix td {
          padding: 12px 18px; font-size: 13px; color: var(--text-primary);
          border-bottom: 1px solid var(--border); text-align: center;
        }
        .um-matrix td:first-child { text-align: left; font-weight: 500; }
        .um-matrix tr:last-child td { border-bottom: none; }
        .um-matrix tr:hover td { background: #FAFCFB; }

        .um-tick { color: var(--accent-dark); font-size: 15px; font-weight: 700; }
        .um-cross { color: #C8D6D0; font-size: 15px; }

        /* ── Modal overlay ───────────────────────── */
        .um-overlay {
          position: fixed; inset: 0; background: rgba(4,52,44,.35);
          display: flex; align-items: center; justify-content: center;
          z-index: 200; padding: 20px;
        }
        .um-modal {
          background: #fff; border-radius: 14px; width: 100%; max-width: 520px;
          box-shadow: 0 12px 48px rgba(4,52,44,.18);
          max-height: 90vh; overflow-y: auto;
        }
        .um-modal-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 20px 24px 0; margin-bottom: 20px;
        }
        .um-modal-title {
          font-size: 18px; font-weight: 700; color: var(--text-primary); margin: 0;
        }
        .um-modal-close {
          background: none; border: none; font-size: 16px;
          color: var(--text-muted); cursor: pointer; padding: 4px;
          line-height: 1; border-radius: 4px;
        }
        .um-modal-close:hover { background: var(--page-bg); color: var(--text-primary); }
        .um-modal-error {
          margin: 0 24px 16px; background: var(--danger-bg);
          color: var(--danger-text); border: 1px solid #F5C4B5;
          border-radius: 8px; padding: 10px 14px; font-size: 13px;
        }
        .um-form-grid {
          display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px;
          padding: 0 24px;
        }
        .um-form-field { display: flex; flex-direction: column; gap: 5px; }
        .um-label {
          font-size: 12.5px; font-weight: 600; color: var(--text-primary);
        }
        .um-required { color: #E24B4A; margin-left: 2px; }
        .um-optional { color: var(--text-muted); font-weight: 400; margin-left: 3px; font-size: 11px; }
        .um-input {
          padding: 9px 12px; border: 1px solid var(--border); border-radius: 7px;
          font-size: 13.5px; color: var(--text-primary); background: #fff; outline: none;
          transition: border-color .15s;
        }
        .um-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(29,158,117,.1); }
        .um-select { cursor: pointer; }
        .um-checkbox-field { flex-direction: row !important; align-items: center; gap: 8px; grid-column: span 2; }
        .um-checkbox-label {
          display: flex; align-items: center; gap: 8px;
          font-size: 13.5px; color: var(--text-primary); cursor: pointer;
        }
        .um-checkbox { width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent-dark); }
        .um-modal-footer {
          display: flex; justify-content: flex-end; gap: 10px;
          padding: 20px 24px; margin-top: 20px;
          border-top: 1px solid var(--border);
        }
        .um-btn-primary {
          background: var(--accent-dark); color: #fff; border: none;
          border-radius: 8px; padding: 9px 18px; font-size: 13px;
          font-weight: 600; cursor: pointer; transition: background .15s;
        }
        .um-btn-primary:hover:not(:disabled) { background: var(--sidebar-bg); }
        .um-btn-primary:disabled { opacity: .55; cursor: not-allowed; }
        .um-btn-secondary {
          background: #fff; color: var(--text-secondary);
          border: 1px solid var(--border); border-radius: 8px;
          padding: 9px 18px; font-size: 13px; font-weight: 600;
          cursor: pointer; transition: background .15s;
        }
        .um-btn-secondary:hover:not(:disabled) { background: var(--page-bg); }
        .um-btn-secondary:disabled { opacity: .55; cursor: not-allowed; }

        /* ── Confirm prompt ──────────────────────── */
        .um-confirm-banner {
          background: var(--warn-bg); border: 1px solid #F3D199;
          border-radius: 10px; padding: 14px 18px; margin-bottom: 20px;
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
        }
        .um-confirm-text { font-size: 13.5px; color: var(--warn-text); }
        .um-confirm-actions { display: flex; gap: 8px; flex-shrink: 0; }

        /* ── Toast ───────────────────────────────── */
        .um-toast {
          position: fixed; bottom: 28px; right: 28px;
          background: var(--accent-darker); color: #fff;
          padding: 12px 20px; border-radius: 10px; font-size: 14px;
          font-weight: 500; box-shadow: 0 8px 24px rgba(4,52,44,.22);
          animation: toastIn .22s cubic-bezier(.22,1,.36,1); z-index: 300;
        }
        @keyframes toastIn {
          from { opacity: 0; transform: translateY(10px) scale(.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }

        /* ── Empty ───────────────────────────────── */
        .um-empty {
          text-align: center; padding: 40px 24px;
          font-size: 14px; color: var(--text-muted);
        }

        @media (max-width: 640px) {
          .um-form-grid { grid-template-columns: 1fr; }
          .um-checkbox-field { grid-column: span 1; }
          .um-header { flex-direction: column; align-items: flex-start; }
        }
      `}</style>

      <div className="um-page">

        {/* Header */}
        <div className="um-header">
          <div>
            <h1>User Management</h1>
            <p>Manage GreenOps accounts and control role-based access.</p>
          </div>
          <button className="um-add-btn" onClick={() => { setFormErr(""); setModal("add"); }}>
            + Add user
          </button>
        </div>

        {/* Tabs */}
        <div className="um-tabs">
          <button className={`um-tab ${tab === "users" ? "active" : ""}`} onClick={() => setTab("users")}>
            Users
          </button>
          <button className={`um-tab ${tab === "permissions" ? "active" : ""}`} onClick={() => setTab("permissions")}>
            Role permissions
          </button>
        </div>

        {error && (
          <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>
        )}

        {/* Deactivate confirm */}
        {confirmDeactivate && (
          <div className="um-confirm-banner">
            <span className="um-confirm-text">
              Deactivate <strong>{confirmDeactivate.name}</strong>? They will lose access immediately.
            </span>
            <div className="um-confirm-actions">
              <button className="um-row-btn deactivate" onClick={() => handleDeactivate(confirmDeactivate)}>
                Deactivate
              </button>
              <button className="um-row-btn edit" onClick={() => setConfirmDeactivate(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {tab === "users" && (
          <>
            {/* Stats strip */}
            {!loading && (
              <div className="um-stats">
                <div className="um-stat">
                  <div className="um-stat-label">Total users</div>
                  <div className="um-stat-value">{users.length}</div>
                </div>
                <div className="um-stat">
                  <div className="um-stat-label">Active</div>
                  <div className="um-stat-value" style={{ color: "var(--accent-dark)" }}>{activeUsers.length}</div>
                </div>
                {ROLES.map(r => (
                  <div className="um-stat" key={r.value}>
                    <div className="um-stat-label">{r.label.split(" ")[0]}</div>
                    <div className="um-stat-value">
                      {users.filter(u => u.role === r.value && u.is_active).length}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* User table */}
            <div className="um-table-wrap">
              <div className="um-table-header">
                <p className="um-table-title">Active accounts</p>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{activeUsers.length} user{activeUsers.length !== 1 ? "s" : ""}</span>
              </div>
              {loading ? (
                <div className="um-empty">Loading…</div>
              ) : activeUsers.length === 0 ? (
                <div className="um-empty">No active users. Click "Add user" to create one.</div>
              ) : (
                <table className="um-table">
                  <thead>
                    <tr>
                      <th>Employee ID</th>
                      <th>Name / Email</th>
                      <th>Role</th>
                      <th>Added</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeUsers.map(u => (
                      <tr key={u.id}>
                        <td>
                          {u.employee_id
                            ? <span className="um-emp-id">{u.employee_id}</span>
                            : <span style={{ color: "var(--text-muted)", fontSize: 12 }}>—</span>}
                        </td>
                        <td>
                          <div className="um-name">{u.name}</div>
                          <div className="um-email">{u.email}</div>
                        </td>
                        <td>
                          <span className={`badge ${ROLE_BADGE_CLS[u.role] || "neutral"}`}>
                            {ROLE_LABEL[u.role] || u.role}
                          </span>
                        </td>
                        <td style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                          {timeAgo(u.created_at)}
                        </td>
                        <td>
                          <div className="um-row-actions">
                            <button
                              className="um-row-btn edit"
                              onClick={() => { setFormErr(""); setModal(u); }}
                            >
                              Edit
                            </button>
                            <button
                              className="um-row-btn deactivate"
                              onClick={() => setConfirmDeactivate(u)}
                            >
                              Deactivate
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Inactive users */}
            {inactiveUsers.length > 0 && (
              <div className="um-table-wrap">
                <div className="um-table-header">
                  <p className="um-table-title" style={{ color: "var(--text-muted)" }}>
                    Deactivated accounts
                  </p>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{inactiveUsers.length}</span>
                </div>
                <table className="um-table">
                  <thead>
                    <tr>
                      <th>Employee ID</th>
                      <th>Name / Email</th>
                      <th>Role</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inactiveUsers.map(u => (
                      <tr key={u.id} className="um-inactive-row">
                        <td>
                          {u.employee_id
                            ? <span className="um-emp-id">{u.employee_id}</span>
                            : <span style={{ color: "var(--text-muted)", fontSize: 12 }}>—</span>}
                        </td>
                        <td>
                          <div className="um-name">{u.name}</div>
                          <div className="um-email">{u.email}</div>
                        </td>
                        <td>
                          <span className={`badge neutral`}>
                            {ROLE_LABEL[u.role] || u.role}
                          </span>
                        </td>
                        <td>
                          <button
                            className="um-row-btn reactivate"
                            onClick={() => handleReactivate(u)}
                          >
                            Reactivate
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === "permissions" && (
          <div className="um-matrix-wrap">
            <div className="um-matrix-header">
              <p className="um-matrix-title">Role permissions reference</p>
              <p className="um-matrix-sub">
                What each role can see and do in GreenOps. Backend enforced — hiding buttons is UI convenience only.
              </p>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="um-matrix">
                <thead>
                  <tr>
                    <th style={{ width: "36%" }}>Page / Action</th>
                    {ROLES.map(r => (
                      <th key={r.value}>{r.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PERMISSION_MATRIX.map(row => (
                    <tr key={row.page}>
                      <td>{row.page}</td>
                      {ROLES.map(r => (
                        <td key={r.value}>
                          {row[r.value]
                            ? <span className="um-tick">✓</span>
                            : <span className="um-cross">✕</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>

      {/* Add / Edit modal */}
      {modal && (
        <UserFormModal
          existing={modal === "add" ? null : modal}
          onSave={handleSave}
          onClose={() => { setModal(null); setFormErr(""); }}
          saving={saving}
          error={formErr}
        />
      )}

      {toast && <div className="um-toast">{toast}</div>}
    </>
  );
}
