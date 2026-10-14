import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API_BASE = `${BACKEND_URL}/api`;

export const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use((cfg) => {
  const token = localStorage.getItem("mm_token");
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
