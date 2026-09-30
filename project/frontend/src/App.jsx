import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";

import { useAuth } from "./AuthContext";

import Layout from "./Layout";
import Login from "./pages/Login";

import Overview from "./pages/Overview";
import Servers from "./pages/Servers";
import ServerDetail from "./pages/ServerDetail";
import Storage from "./pages/Storage";
import Analytics from "./pages/Analytics";
import ModelEval from "./pages/ModelEval";
import Recommendations from "./pages/Recommendations";
import RecommendationDetail from "./pages/RecommendationDetail";
import ApprovedActions from "./pages/ApprovedActions";
import Preferences from "./pages/Preferences";
import Reports from "./pages/Reports";
import UserManagement from "./pages/UserManagement";

/* ----------------------------------------------------------------
   ProtectedRoute — redirects unauthenticated users to /login,
   preserving the intended destination so login can redirect back.
---------------------------------------------------------------- */
function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>

        {/* Public route */}
        <Route path="/login" element={<Login />} />

        {/* All dashboard routes require authentication */}
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          {/* Dashboard */}
          <Route index element={<Overview />} />

          {/* Infrastructure */}
          <Route path="servers" element={<Servers />} />
          <Route path="servers/:id" element={<ServerDetail />} />

          {/* Storage */}
          <Route path="storage" element={<Storage />} />

          {/* Analytics */}
          <Route path="analytics" element={<Analytics />} />

          {/* ML — kept in routing but not shown in role-based sidebar */}
          <Route path="model-eval" element={<ModelEval />} />

          {/* Recommendations */}
          <Route path="recommendations" element={<Recommendations />} />
          <Route path="recommendations/:id" element={<RecommendationDetail />} />

          {/* Approved actions */}
          <Route path="approved-actions" element={<ApprovedActions />} />

          {/* Preferences */}
          <Route path="preferences" element={<Preferences />} />

          {/* ESG report */}
          <Route path="reports" element={<Reports />} />

          {/* User management — infrastructure_manager only */}
          <Route path="users" element={<UserManagement />} />

        </Route>

        {/* Catch-all → home (which will redirect to /login if not authed) */}
        <Route path="*" element={<Navigate to="/" replace />} />

      </Routes>
    </BrowserRouter>
  );
}
