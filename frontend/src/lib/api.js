import axios from "axios";
import { supabase } from "@/lib/supabase";

const FUNCTIONS_URL = (process.env.REACT_APP_SUPABASE_FUNCTIONS_URL || `${process.env.REACT_APP_SUPABASE_URL}/functions/v1/market-api`).replace(/\/$/, "");
export const API_BASE = `${FUNCTIONS_URL}/api`;

export const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use(async (cfg) => {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

export function formatApiError(err) {
  const d = err?.response?.data?.detail;
  if (d == null) return err?.message || "Request failed";
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((e) => e?.msg || JSON.stringify(e)).join(" ");
  if (d && typeof d.msg === "string") return d.msg;
  return String(d);
}
