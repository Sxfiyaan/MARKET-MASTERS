import axios from "axios";
import { supabase } from "@/lib/supabase";

const FUNCTIONS_URL = (process.env.REACT_APP_SUPABASE_FUNCTIONS_URL || `${process.env.REACT_APP_SUPABASE_URL}/functions/v1/market-api`).replace(/\/$/, "");
export const API_BASE = `${FUNCTIONS_URL}/api`;

export const http = axios.create({ baseURL: API_BASE });

http.interceptors.request.use(async (cfg) => {
  const key = process.env.REACT_APP_SUPABASE_PUBLISHABLE_KEY;
  if (key) {
    cfg.headers = cfg.headers || {};
    cfg.headers.apikey = key;
  }

  // Public registration: adhere to Supabase contract by sending only apikey and stripping stale Authorization
  const isPublicAuth = cfg.url === "/auth/register-team" || cfg.url?.endsWith("/auth/register-team");
  if (isPublicAuth) {
    if (cfg.headers) {
      delete cfg.headers.Authorization;
      delete cfg.headers.authorization;
    }
    return cfg;
  }

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) {
    cfg.headers.Authorization = `Bearer ${token}`;
  } else {
    delete cfg.headers.Authorization;
  }
  return cfg;
});

const publicConfigFields = "id,event_name,team_size,registration_open,round1_weight,round2_weight,round3_weight,round3_duration_minutes,max_trades,starting_capital,max_risk_per_trade,performance_weight,risk_mgmt_weight,leaderboard_visible,trade_proof_required,speed_bonus_pct,rounds";

function directApiError(error) {
  const wrapped = new Error(error?.message || "Public data request failed");
  wrapped.response = { status: 500, data: { detail: wrapped.message } };
  return wrapped;
}

async function publicGet(path, config) {
  if (path === "/event/config") {
    const { data, error } = await supabase.from("event_config").select(publicConfigFields).eq("id", "event").single();
    if (error) throw directApiError(error);
    return { data };
  }

  if (path === "/leaderboard") {
    const [configResult, leaderboardResult] = await Promise.all([
      supabase.from("event_config").select("leaderboard_visible").eq("id", "event").single(),
      supabase.from("leaderboard_snapshot").select("team_id,team_name,college,round1,round2,round3,risk_score,total,rank,rank_change").order("rank", { ascending: true }),
    ]);
    if (configResult.error) throw directApiError(configResult.error);
    if (leaderboardResult.error) throw directApiError(leaderboardResult.error);
    return { data: { visible: configResult.data.leaderboard_visible, rows: leaderboardResult.data || [] } };
  }

  return http.get(path, config);
}

export const api = {
  get: publicGet,
  post: (...args) => http.post(...args),
  put: (...args) => http.put(...args),
  delete: (...args) => http.delete(...args),
};

export function formatApiError(err) {
  const d = err?.response?.data?.detail;
  if (d == null) return err?.message || "Request failed";
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((e) => e?.msg || JSON.stringify(e)).join(" ");
  if (d && typeof d.msg === "string") return d.msg;
  return String(d);
}
