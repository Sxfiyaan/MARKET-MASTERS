import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, formatApiError } from "@/lib/api";
import { supabase } from "@/lib/supabase";

const AuthContext = createContext(null);

async function hydrateUser(fallbackUser) {
  try {
    const { data } = await api.get("/auth/me");
    return data;
  } catch {
    return fallbackUser;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) { setUser(null); setLoading(false); return; }
    try {
      const { data } = await api.get("/auth/me");
      setUser(data);
    } catch {
      localStorage.removeItem("mm_token");
      setUser(null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    refresh();
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") setUser(null);
      else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") refresh();
    });
    return () => listener.subscription.unsubscribe();
  }, [refresh]);

  const login = async (email, password) => {
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
      if (error) throw error;
      const user = await hydrateUser(null);
      setUser(user);
      return { ok: true, user };
    } catch (e) {
      return { ok: false, error: formatApiError(e) };
    }
  };

  const register = async (payload) => {
    try {
      const { data } = await api.post("/auth/register-team", payload);
      const { error } = await supabase.auth.signInWithPassword({ email: payload.leader_email.trim().toLowerCase(), password: payload.password });
      if (error) throw error;
      const user = await hydrateUser(data.user);
      setUser(user);
      return { ok: true, user };
    } catch (e) {
      return { ok: false, error: formatApiError(e) };
    }
  };

  const logout = async () => {
    try { await api.post("/auth/logout"); } catch {}
    await supabase.auth.signOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
