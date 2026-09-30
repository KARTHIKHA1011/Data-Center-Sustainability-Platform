import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";

/* ----------------------------------------------------------------
   Role-based navigation config.
   Model Evaluation is intentionally excluded from all three
   production roles per spec — the route still exists at /model-eval.
---------------------------------------------------------------- */
const NAV_BY_ROLE = {
  infrastructure_manager: [
    { to: "/",                label: "Overview",         icon: "▦", end: true },
    { to: "/servers",         label: "Servers",          icon: "▤" },
    { to: "/storage",         label: "Storage",          icon: "▥" },
    { to: "/analytics",       label: "Analytics",        icon: "▧" },
    { to: "/recommendations", label: "Recommendations",  icon: "✓" },
    { to: "/approved-actions",label: "Approved actions", icon: "◉" },
    { to: "/reports",         label: "ESG report",       icon: "▦" },
    { to: "/preferences",     label: "Preferences",      icon: "⚙" },
    { to: "/users",           label: "User management",  icon: "👥" },
  ],
  sustainability_manager: [
    { to: "/",                label: "Overview",        icon: "▦", end: true },
    { to: "/analytics",       label: "Analytics",       icon: "▧" },
    { to: "/recommendations", label: "Recommendations", icon: "✓" },
    { to: "/reports",         label: "ESG report",      icon: "▦" },
    { to: "/preferences",     label: "Preferences",     icon: "⚙" },
  ],
  operations_engineer: [
    { to: "/",                label: "Overview",         icon: "▦", end: true },
    { to: "/servers",         label: "Servers",          icon: "▤" },
    { to: "/storage",         label: "Storage",          icon: "▥" },
    { to: "/analytics",       label: "Analytics",        icon: "▧" },
    { to: "/recommendations", label: "Recommendations",  icon: "✓" },
    { to: "/approved-actions",label: "Approved actions", icon: "◉" },
    { to: "/preferences",     label: "Preferences",      icon: "⚙" },
  ],
};

const ROLE_LABEL = {
  infrastructure_manager: "Infrastructure Manager",
  sustainability_manager:  "Sustainability Manager",
  operations_engineer:     "Operations Engineer",
};

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const links = NAV_BY_ROLE[user?.role] || [];

  const handleLogout = () => {
    logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="app-shell">

      {/* SIDEBAR */}
      <div className="sidebar">

        {/* LOGO */}
        <div className="sidebar-logo">
          <span className="sidebar-logo-icon">🌿</span>
          GreenOps
        </div>

        {/* NAVIGATION */}
        <nav style={{ flex: 1 }}>
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                "sidebar-link" + (isActive ? " active" : "")
              }
            >
              <span aria-hidden="true">{link.icon}</span>
              {link.label}
            </NavLink>
          ))}
        </nav>

        {/* USER STRIP + LOGOUT */}
        <div style={{
          marginTop: "auto",
          paddingTop: "12px",
          borderTop: "1px solid rgba(255,255,255,0.08)",
        }}>
          {user && (
            <div style={{
              padding: "8px 12px 6px",
              fontSize: "11.5px",
              color: "rgba(159,225,203,0.7)",
              lineHeight: 1.4,
            }}>
              <div style={{ fontWeight: 600, color: "#9FE1CB", marginBottom: 2 }}>
                {user.name}
              </div>
              <div style={{ fontSize: "10.5px" }}>
                {ROLE_LABEL[user.role] || user.role}
              </div>
            </div>
          )}
          <button
            onClick={handleLogout}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              width: "100%",
              padding: "9px 12px",
              background: "transparent",
              border: "none",
              borderRadius: "8px",
              color: "rgba(159,225,203,0.7)",
              fontSize: "13px",
              cursor: "pointer",
              transition: "background 0.15s",
              marginTop: "2px",
              textAlign: "left",
            }}
            onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.06)"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
          >
            <span aria-hidden="true" style={{ fontSize: "13px" }}>⎋</span>
            Sign out
          </button>
        </div>

      </div>

      {/* MAIN CONTENT */}
      <div className="main-content">
        <Outlet />
      </div>

    </div>
  );
}
