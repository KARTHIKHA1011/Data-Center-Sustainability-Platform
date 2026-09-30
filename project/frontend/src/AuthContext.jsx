/**
 * AuthContext — single source of truth for authentication state.
 *
 * Stores the JWT in localStorage under "greenops_token" and the user
 * profile under "greenops_user". Both are cleared on logout or when a
 * 401 is received from the API (handled in api.js interceptor).
 *
 * Exposed via useAuth() hook from any component.
 */
import { createContext, useContext, useState, useCallback } from "react";

const AuthContext = createContext(null);

const TOKEN_KEY = "greenops_token";
const USER_KEY  = "greenops_user";

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || null);
  const [user,  setUser]  = useState(() => {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  const login = useCallback((tokenStr, userObj) => {
    localStorage.setItem(TOKEN_KEY, tokenStr);
    localStorage.setItem(USER_KEY, JSON.stringify(userObj));
    setToken(tokenStr);
    setUser(userObj);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const isAuthenticated = !!token && !!user;

  return (
    <AuthContext.Provider value={{ token, user, isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
