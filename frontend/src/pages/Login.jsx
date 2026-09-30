import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../AuthContext";
import api from "../api";

const ROLE_LABEL = {
  infrastructure_manager: "Infrastructure Manager",
  sustainability_manager:  "Sustainability Manager",
  operations_engineer:     "Operations Engineer",
};

export default function Login() {
  const { login } = useAuth();
  const navigate  = useNavigate();
  const location  = useLocation();

  const [email,       setEmail]       = useState("");
  const [password,    setPassword]    = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error,       setError]       = useState("");
  const [loading,     setLoading]     = useState(false);

  // After login redirect to wherever they were trying to go (default: "/")
  const from = location.state?.from?.pathname || "/";

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError("Please enter both email and password.");
      return;
    }
    try {
      setLoading(true);
      setError("");
      const res = await api.login(email.trim(), password);
      const data = res.data;
      login(data.access_token, {
        id:   data.user_id,
        name: data.name,
        role: data.role,
      });
      navigate(from, { replace: true });
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(detail || "Login failed. Please check your credentials.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <style>{`
        .login-shell {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--page-bg, #F2F8F5);
          padding: 24px;
        }

        .login-card {
          background: #fff;
          border: 1px solid var(--border, #E3ECE8);
          border-radius: 16px;
          padding: 40px 44px;
          width: 100%;
          max-width: 420px;
          box-shadow: 0 4px 24px rgba(4, 52, 44, 0.08);
        }

        .login-logo {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 28px;
        }

        .login-logo-icon {
          width: 36px;
          height: 36px;
          border-radius: 10px;
          background: var(--sidebar-bg, #04342C);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          flex-shrink: 0;
        }

        .login-logo-text {
          font-size: 20px;
          font-weight: 700;
          color: var(--text-primary, #1C2622);
          line-height: 1;
        }

        .login-logo-sub {
          font-size: 11.5px;
          color: var(--text-muted, #8A9691);
          margin-top: 2px;
        }

        .login-title {
          font-size: 22px;
          font-weight: 700;
          color: var(--text-primary, #1C2622);
          margin: 0 0 6px;
        }

        .login-subtitle {
          font-size: 13.5px;
          color: var(--text-secondary, #5F6E68);
          margin: 0 0 28px;
          line-height: 1.5;
        }

        .login-field {
          margin-bottom: 16px;
        }

        .login-label {
          display: block;
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary, #1C2622);
          margin-bottom: 6px;
        }

        .login-input {
          width: 100%;
          padding: 10px 13px;
          border: 1px solid var(--border, #E3ECE8);
          border-radius: 8px;
          font-size: 14px;
          color: var(--text-primary, #1C2622);
          background: #fff;
          outline: none;
          transition: border-color 0.15s;
          box-sizing: border-box;
        }

        .login-input:focus {
          border-color: var(--accent, #1D9E75);
          box-shadow: 0 0 0 3px rgba(29, 158, 117, 0.1);
        }

        .login-input::placeholder {
          color: var(--text-muted, #8A9691);
        }

        .login-password-wrap {
          position: relative;
        }

        .login-password-wrap .login-input {
          padding-right: 60px;
        }

        .login-password-toggle {
          position: absolute;
          top: 50%;
          right: 6px;
          transform: translateY(-50%);
          background: none;
          border: none;
          padding: 4px 8px;
          font-size: 12px;
          font-weight: 600;
          color: var(--text-secondary, #5F6E68);
          cursor: pointer;
          border-radius: 6px;
        }

        .login-password-toggle:hover:not(:disabled) {
          background: var(--page-bg, #F2F8F5);
          color: var(--accent-dark, #0F6E56);
        }

        .login-password-toggle:disabled {
          cursor: not-allowed;
          opacity: 0.5;
        }

        .login-error {
          background: var(--danger-bg, #FAECE7);
          color: var(--danger-text, #993C1D);
          border: 1px solid #F5C4B5;
          border-radius: 8px;
          padding: 10px 14px;
          font-size: 13px;
          margin-bottom: 18px;
          line-height: 1.4;
        }

        .login-btn {
          width: 100%;
          padding: 11px;
          background: var(--accent-dark, #0F6E56);
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s;
          margin-top: 4px;
        }

        .login-btn:hover:not(:disabled) {
          background: var(--sidebar-bg, #04342C);
        }

        .login-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .login-hint {
          margin-top: 24px;
          padding-top: 20px;
          border-top: 1px solid var(--border, #E3ECE8);
        }

        .login-hint-title {
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--text-muted, #8A9691);
          margin: 0 0 10px;
        }

        .login-hint-row {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .login-hint-entry {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 12px;
          color: var(--text-secondary, #5F6E68);
          background: var(--page-bg, #F2F8F5);
          border-radius: 6px;
          padding: 7px 10px;
          cursor: pointer;
          transition: background 0.12s;
          gap: 8px;
        }

        .login-hint-entry:hover {
          background: #e8f5ef;
        }

        .login-hint-email {
          font-family: "SFMono-Regular", Consolas, monospace;
          font-size: 11.5px;
          color: var(--text-primary, #1C2622);
        }

        .login-hint-role {
          font-size: 11px;
          color: var(--text-muted, #8A9691);
          text-align: right;
          white-space: nowrap;
        }
      `}</style>

      <div className="login-shell">
        <div className="login-card">

          {/* Logo */}
          <div className="login-logo">
            <div className="login-logo-icon">🌿</div>
            <div>
              <div className="login-logo-text">GreenOps</div>
              <div className="login-logo-sub">Resource Intelligence Platform</div>
            </div>
          </div>

          {/* Heading */}
          <h1 className="login-title">Sign in</h1>
          <p className="login-subtitle">
            Enter your credentials to access the dashboard.
          </p>

          {/* Error */}
          {error && <div className="login-error">{error}</div>}

          {/* Form */}
          <form onSubmit={handleSubmit} noValidate>
            <div className="login-field">
              <label className="login-label" htmlFor="email">Email</label>
              <input
                id="email"
                className="login-input"
                type="email"
                autoComplete="email"
                placeholder="you@greenops.local"
                value={email}
                onChange={e => setEmail(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="login-field">
              <label className="login-label" htmlFor="password">Password</label>
              <div className="login-password-wrap">
                <input
                  id="password"
                  className="login-input"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  disabled={loading}
                />
                <button
                  type="button"
                  className="login-password-toggle"
                  onClick={() => setShowPassword(v => !v)}
                  disabled={loading}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  tabIndex={-1}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            <button className="login-btn" type="submit" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>

          {/* Dev hint — click to auto-fill */}
          <div className="login-hint">
            <p className="login-hint-title">Development accounts — click to fill</p>
            <div className="login-hint-row">
              {[
                { email: "infra@greenops.local",         role: "infrastructure_manager" },
                { email: "sustainability@greenops.local", role: "sustainability_manager" },
                { email: "operations@greenops.local",    role: "operations_engineer" },
              ].map(u => (
                <div
                  key={u.email}
                  className="login-hint-entry"
                  onClick={() => { setEmail(u.email); setError(""); }}
                  title="Click to fill email"
                >
                  <span className="login-hint-email">{u.email}</span>
                  <span className="login-hint-role">{ROLE_LABEL[u.role]}</span>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
