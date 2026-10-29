import React, { useEffect, useState } from "react";
import Nav from "@/components/Nav";
import { api, formatApiError } from "@/lib/api";
import { toast } from "sonner";
import QuestionsPanel from "@/pages/QuestionsPanel";

const STATES = ["UPCOMING", "ACTIVE", "PAUSED", "COMPLETED"];

export default function Admin() {
  const [cfg, setCfg] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [trades, setTrades] = useState([]);
  const [teams, setTeams] = useState([]);
  const [audit, setAudit] = useState([]);
  const [annMsg, setAnnMsg] = useState("");
  const [tab, setTab] = useState("control");
  const [explanations, setExplanations] = useState([]);

  const load = async () => {
    try {
      const [c, a, t, tm, al, ex] = await Promise.all([
        api.get("/event/config"),
        api.get("/admin/analytics"),
        api.get("/admin/trades"),
        api.get("/admin/teams"),
        api.get("/admin/audit-logs"),
        api.get("/admin/round2/explanations").catch(() => ({ data: [] })),
      ]);
      setCfg(c.data); setAnalytics(a.data); setTrades(t.data); setTeams(tm.data); setAudit(al.data);
      setExplanations(ex?.data || []);
    } catch (e) { toast.error(formatApiError(e)); }
  };
  useEffect(() => { load(); const i = setInterval(load, 10000); return () => clearInterval(i); }, []);

  const setState = async (round, state) => {
    try { await api.post(`/rounds/${round}/state`, { state }); toast.success(`Round ${round} → ${state}`); await load(); }
    catch (e) { toast.error(formatApiError(e)); }
  };

  const verify = async (id, status) => {
    const reason = status === "REJECTED" ? window.prompt("Reason for rejection:") : null;
    if (status === "REJECTED" && !reason) return;
    try { await api.post(`/admin/trades/${id}/verify`, { status, reason }); toast.success(`Trade ${status}`); await load(); }
    catch (e) { toast.error(formatApiError(e)); }
  };

  const deleteTrade = async (id) => {
    if (!window.confirm("Permanently delete this trade?")) return;
    try { await api.delete(`/admin/trades/${id}`); toast.success("Trade deleted"); await load(); }
    catch (e) { toast.error(formatApiError(e)); }
  };

  const deleteTeam = async (id, name) => {
    if (!window.confirm(`Delete team "${name}" and ALL its data (user, submissions, trades)? This cannot be undone.`)) return;
    try { await api.delete(`/admin/teams/${id}`); toast.success("Team deleted"); await load(); }
    catch (e) { toast.error(formatApiError(e)); }
  };

  const eventAction = async (action, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    try { await api.post("/admin/event/action", { action }); toast.success(`Event ${action}`); await load(); }
    catch (e) { toast.error(formatApiError(e)); }
  };

  const broadcast = async () => {
    if (!annMsg) return;
    try { await api.post("/announcements", { message: annMsg }); setAnnMsg(""); toast.success("Broadcast sent"); await load(); }
    catch (e) { toast.error(formatApiError(e)); }
  };

  const saveCfg = async (patch) => {
    try { const { data } = await api.put("/event/config", patch); setCfg(data); toast.success("Config saved"); }
    catch (e) { toast.error(formatApiError(e)); }
  };

  const exportCsv = async (kind) => {
    try {
      const { data } = await api.get(`/admin/export/${kind}`, { responseType: "blob" });
      const u = URL.createObjectURL(data); const a = document.createElement("a");
      a.href = u; a.download = `${kind}.csv`; a.click(); URL.revokeObjectURL(u);
    } catch (e) { toast.error(formatApiError(e)); }
  };

  if (!cfg || !analytics) return <Shell><div className="font-mono text-xs text-mm-text2">Loading…</div></Shell>;

  const Tab = ({ k, label }) => (
    <button data-testid={`admin-tab-${k}`} onClick={() => setTab(k)} className={`px-4 py-2 font-mono text-[11px] tracking-widest border ${tab === k ? "border-mm-gold text-mm-gold" : "border-mm-border text-mm-text2"} hover:border-mm-gold`}>{label}</button>
  );

  return (
    <Shell>
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// ADMIN CONTROL ROOM</div>
          <h1 className="font-serif text-5xl mt-3">The floor director.</h1>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Tab k="control" label="Event Control" />
          <Tab k="questions-r1" label="R1 Questions" />
          <Tab k="questions-r2" label="R2 Charts" />
          <Tab k="explanations" label="R2 Explanations" />
          <Tab k="verify" label="Trade Verify" />
          <Tab k="teams" label="Teams" />
          <Tab k="config" label="Config" />
          <Tab k="audit" label="Audit" />
          <Tab k="export" label="Export" />
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mt-8">
        <Stat label="Teams" value={analytics.total_teams} tid="a-stat-teams" />
        <Stat label="R1 Subs" value={analytics.r1_submissions} tid="a-stat-r1" />
        <Stat label="R2 Subs" value={analytics.r2_submissions} tid="a-stat-r2" />
        <Stat label="Trades" value={`${analytics.trades_total} (${analytics.trade_1}+${analytics.trade_2})`} tid="a-stat-trades" />
        <Stat label="Pending" value={analytics.pending_verification} color="text-mm-gold" tid="a-stat-pending" />
        <Stat label="Verified" value={analytics.verified} color="text-mm-green" tid="a-stat-verified" />
        <Stat label="Rejected" value={analytics.rejected} color="text-mm-red" tid="a-stat-rejected" />
        <Stat label="Avg Return" value={`${analytics.avg_return_pct}%`} tid="a-stat-avg" />
        <Stat label="Best Return" value={`${analytics.best_return_pct}%`} tid="a-stat-best" />
        <Stat label="Best Risk" value={analytics.best_risk_score} tid="a-stat-risk" />
      </div>

      {tab === "control" && (
        <div className="space-y-6 mt-8">
          <div className="mm-panel mm-corner-ticks p-6" data-testid="event-master-controls">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <div className="font-mono text-[11px] tracking-widest text-mm-gold">// MASTER EVENT CONTROL</div>
                <div className="font-serif text-2xl mt-2">
                  Registration: <span className={cfg.registration_open ? "text-mm-green" : "text-mm-red"}>{cfg.registration_open ? "OPEN" : "CLOSED"}</span>
                  <span className="text-mm-text2 mx-3">·</span>
                  Leaderboard: <span className={cfg.leaderboard_visible ? "text-mm-green" : "text-mm-red"}>{cfg.leaderboard_visible ? "VISIBLE" : "HIDDEN"}</span>
                  <span className="text-mm-text2 mx-3">·</span>
                  Results: <span className={cfg.results_finalized ? "text-mm-green" : "text-mm-gold"}>{cfg.results_finalized ? "FINALIZED" : "UNFINALIZED"}</span>
                </div>
              </div>
              <div className="flex gap-3 flex-wrap">
                <button onClick={() => eventAction("start", "Start the event? Opens registration and resets all rounds to UPCOMING.")} data-testid="event-start-btn" className="btn-primary">▶ Start Event</button>
                <button onClick={() => eventAction("stop", "Stop the event? Closes registration and marks all rounds COMPLETED. Scores remain visible.")} data-testid="event-stop-btn" className="btn-ghost border-mm-red text-mm-red hover:border-mm-red">■ Stop Event</button>
                {cfg.results_finalized ? (
                  <button onClick={() => eventAction("reopen", "Reopen results? This allows score modifications and pending trade reviews again.")} data-testid="event-reopen-btn" className="btn-ghost border-mm-gold text-mm-gold hover:bg-mm-gold/10">🔓 Reopen Results</button>
                ) : (
                  <button onClick={() => eventAction("finalize", "Finalize results? This action authoritatively publishes final ceremony standings. All rounds must be completed and pending trade verifications must be complete.")} data-testid="event-finalize-btn" className="btn-primary border-mm-gold text-mm-gold hover:bg-mm-gold/10">★ Finalize Results</button>
                )}
                <button onClick={() => eventAction("reset", "RESET WIPES all submissions, trades, Round 3 sessions, and overrides. Teams and questions are preserved. Continue?")} data-testid="event-reset-btn" className="btn-ghost">↺ Reset Gameplay</button>
              </div>
            </div>
          </div>

          <div className="grid lg:grid-cols-3 gap-6">
            {[1, 2, 3].map((r) => (
              <div key={r} className="mm-panel mm-corner-ticks p-6" data-testid={`admin-round-${r}`}>
                <div className="font-mono text-[11px] tracking-widest text-mm-gold">ROUND / 0{r}</div>
                <div className="font-serif text-3xl mt-3">{["THE QUIZ", "THE CALL", "THE TRADE"][r - 1]}</div>
                <div className="font-mono text-xs mt-3 text-mm-text2">State: <span className="text-mm-text">{cfg.rounds[r].state}</span></div>
                <div className="grid grid-cols-2 gap-2 mt-5">
                  {STATES.map((s) => (
                    <button key={s} onClick={() => setState(r, s)} data-testid={`admin-r${r}-${s}`} className={`px-3 py-2 font-mono text-[10px] tracking-widest border ${cfg.rounds[r].state === s ? "border-mm-gold text-mm-gold" : "border-mm-border text-mm-text2 hover:border-mm-gold"}`}>{s}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mm-panel mm-corner-ticks p-6">
            <div className="font-mono text-[11px] tracking-widest text-mm-gold">// BROADCAST</div>
            <div className="flex gap-3 mt-3">
              <input value={annMsg} onChange={(e) => setAnnMsg(e.target.value)} placeholder="Announcement to all teams…" data-testid="admin-announce-input" className="flex-1 px-4 py-3 font-mono text-sm" />
              <button onClick={broadcast} data-testid="admin-announce-send" className="btn-primary">Send</button>
            </div>
          </div>
        </div>
      )}

      {tab === "questions-r1" && <QuestionsPanel initialRound={1} key="r1" />}
      {tab === "questions-r2" && <QuestionsPanel initialRound={2} key="r2" />}

      {tab === "explanations" && (
        <div className="space-y-4 mt-8">
          <div className="flex items-center justify-between">
            <div className="font-mono text-xs text-mm-text2">
              Showing {explanations.length} Round 2 submissions with mandatory explanations.
            </div>
            <button onClick={() => exportCsv("round2")} data-testid="admin-export-r2-btn" className="btn-ghost text-xs">
              ⬇ Export round2.csv
            </button>
          </div>
          <div className="mm-panel mm-corner-ticks overflow-x-auto" data-testid="admin-explanations-table">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left font-mono text-[10px] tracking-widest text-mm-text2 border-b border-mm-border">
                  <th className="p-3">TEAM</th>
                  <th className="p-3">#</th>
                  <th className="p-3">DECISION</th>
                  <th className="p-3">CORRECT</th>
                  <th className="p-3">PTS</th>
                  <th className="p-3">EXPLANATION</th>
                  <th className="p-3 text-right">TIME</th>
                </tr>
              </thead>
              <tbody>
                {explanations.map((e) => (
                  <tr key={e.id} className="border-b border-mm-border/50" data-testid={`admin-explanation-row-${e.id}`}>
                    <td className="p-3 font-serif">{e.team_name}</td>
                    <td className="p-3 font-mono">Q{Number(e.question_order) + 1}</td>
                    <td className="p-3 font-mono">
                      <span className={`px-2 py-0.5 text-xs font-bold ${
                        e.decision === "BUY" ? "text-mm-green bg-mm-green/10" :
                        e.decision === "SELL" ? "text-mm-red bg-mm-red/10" : "text-mm-gold bg-mm-gold/10"
                      }`}>
                        {e.decision}
                      </span>
                    </td>
                    <td className="p-3 font-mono text-xs">{e.correct_answer || "—"}</td>
                    <td className="p-3 font-mono text-xs">{e.score ?? 0}</td>
                    <td className="p-3 font-mono text-xs max-w-md text-mm-text break-words">
                      "{e.explanation}"
                    </td>
                    <td className="p-3 font-mono text-[11px] text-mm-text2 text-right">
                      {new Date(e.submitted_at).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
                {explanations.length === 0 && (
                  <tr>
                    <td colSpan="7" className="p-10 text-center text-mm-text2 font-mono text-xs">
                      No Round 2 explanations submitted yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "verify" && (
        <div className="mm-panel mm-corner-ticks mt-8 overflow-x-auto" data-testid="admin-verify-table">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left font-mono text-[10px] tracking-widest text-mm-text2 border-b border-mm-border">
                <th className="p-3">TEAM</th>
                <th className="p-3">#</th>
                <th className="p-3">ASSET</th>
                <th className="p-3 text-right">CAPITAL</th>
                <th className="p-3 text-right">RISK</th>
                <th className="p-3">RES</th>
                <th className="p-3 text-right">P/L (₹)</th>
                <th className="p-3 text-right">P/L%</th>
                <th className="p-3">STATUS</th>
                <th className="p-3">ACTION</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className="border-b border-mm-border/50" data-testid={`admin-trade-${t.id}`}>
                  <td className="p-3 font-serif">{t.team_name}</td>
                  <td className="p-3 font-mono">{t.trade_number}</td>
                  <td className="p-3 font-mono">{t.asset}</td>
                  <td className="p-3 text-right font-mono">₹{Number(t.account_size || 0).toLocaleString()}</td>
                  <td className="p-3 text-right font-mono">{t.risk_per_trade}%</td>
                  <td className={`p-3 font-mono ${t.result_type === "PROFIT" ? "text-mm-green" : "text-mm-red"}`}>{t.result_type}</td>
                  <td className={`p-3 text-right font-mono ${t.result_type === "PROFIT" ? "text-mm-green" : "text-mm-red"}`}>
                    {t.result_type === "PROFIT" ? `+₹${Number(t.profit || 0).toLocaleString()}` : `-₹${Number(t.loss || 0).toLocaleString()}`}
                  </td>
                  <td className={`p-3 text-right font-mono ${t.pl_percentage >= 0 ? "text-mm-green" : "text-mm-red"}`}>{t.pl_percentage}%</td>
                  <td className="p-3 font-mono text-[11px]">
                    <span className={`px-2 py-0.5 rounded font-bold ${
                      t.verification_status === "VERIFIED" ? "text-mm-green bg-mm-green/10" :
                      t.verification_status === "REJECTED" ? "text-mm-red bg-mm-red/10" : "text-mm-gold bg-mm-gold/10"
                    }`}>
                      {t.verification_status}
                    </span>
                    {t.admin_notes && <div className="text-[10px] text-mm-text2 mt-1">({t.admin_notes})</div>}
                  </td>
                  <td className="p-3">
                    <button onClick={() => verify(t.id, "VERIFIED")} data-testid={`admin-verify-${t.id}`} className="text-[11px] font-mono tracking-widest text-mm-green hover:underline mr-3">VERIFY</button>
                    <button onClick={() => verify(t.id, "REJECTED")} data-testid={`admin-reject-${t.id}`} className="text-[11px] font-mono tracking-widest text-mm-red hover:underline mr-3">REJECT</button>
                    <button onClick={() => deleteTrade(t.id)} data-testid={`admin-trade-delete-${t.id}`} className="text-[11px] font-mono tracking-widest text-mm-text2 hover:text-mm-red hover:underline">DELETE</button>
                  </td>
                </tr>
              ))}
              {trades.length === 0 && <tr><td colSpan="10" className="p-10 text-center text-mm-text2 font-mono text-xs">No trades submitted yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === "teams" && (
        <div className="mm-panel mm-corner-ticks mt-8 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left font-mono text-[10px] tracking-widest text-mm-text2 border-b border-mm-border"><th className="p-3">TEAM</th><th className="p-3">LEADER</th><th className="p-3">EMAIL</th><th className="p-3">COLLEGE</th><th className="p-3">MEMBERS</th><th className="p-3"></th></tr></thead>
            <tbody>{teams.map((t) => (
              <tr key={t.id} className="border-b border-mm-border/50" data-testid={`admin-team-row-${t.id}`}>
                <td className="p-3 font-serif">{t.team_name}</td>
                <td className="p-3">{t.leader_name}</td>
                <td className="p-3 font-mono text-xs">{t.leader_email}</td>
                <td className="p-3">{t.college}</td>
                <td className="p-3 text-xs">{(t.members || []).join(", ")}</td>
                <td className="p-3">
                  <button onClick={() => deleteTeam(t.id, t.team_name)} data-testid={`admin-team-delete-${t.id}`} className="text-[11px] font-mono tracking-widest text-mm-red hover:underline">DELETE</button>
                </td>
              </tr>))}
            {teams.length === 0 && <tr><td colSpan="6" className="p-10 text-center text-mm-text2 font-mono text-xs">No teams registered yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === "config" && (
        <div className="mm-panel mm-corner-ticks p-6 mt-8">
          <div className="font-mono text-[11px] tracking-widest text-mm-gold mb-4">// EVENT CONFIG</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {[
              ["round1_weight", "R1 Weight %"], ["round2_weight", "R2 Weight %"], ["round3_weight", "R3 Weight %"],
              ["round3_duration_minutes", "R3 Duration (min)"], ["max_trades", "Max Trades R3"],
              ["starting_capital", "Starting Capital"], ["max_risk_per_trade", "Max Risk / Trade %"],
              ["performance_weight", "Performance Weight %"], ["risk_mgmt_weight", "Risk Mgmt Weight %"],
              ["speed_bonus_pct", "Speed Bonus (0-1)"],
            ].map(([k, label]) => (
              <label key={k} className="block">
                <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2 mb-2">{label}</div>
                <input type="number" step="0.1" defaultValue={cfg[k]} onBlur={(e) => saveCfg({ [k]: +e.target.value })} data-testid={`cfg-${k}`} className="w-full px-4 py-3 font-mono text-sm" />
              </label>
            ))}
            {[["registration_open", "Registration Open"], ["leaderboard_visible", "Leaderboard Visible"], ["trade_proof_required", "Trade Proof Required"]].map(([k, label]) => (
              <label key={k} className="flex items-center justify-between border border-mm-border p-3">
                <span className="font-mono text-[10px] uppercase tracking-widest text-mm-text2">{label}</span>
                <input type="checkbox" defaultChecked={cfg[k]} onChange={(e) => saveCfg({ [k]: e.target.checked })} data-testid={`cfg-${k}`} className="w-5 h-5" />
              </label>
            ))}
          </div>
        </div>
      )}

      {tab === "audit" && (
        <div className="mm-panel mm-corner-ticks mt-8 overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead><tr className="text-left tracking-widest text-mm-text2 border-b border-mm-border"><th className="p-3">TIME</th><th className="p-3">USER</th><th className="p-3">ACTION</th><th className="p-3">DETAILS</th></tr></thead>
            <tbody>{audit.map((a) => (<tr key={a.id} className="border-b border-mm-border/50"><td className="p-3 text-mm-text2">{new Date(a.timestamp).toLocaleString()}</td><td className="p-3">{a.user_email || "-"}</td><td className="p-3 text-mm-gold">{a.action}</td><td className="p-3 text-mm-text2 truncate max-w-xs">{JSON.stringify(a.details)}</td></tr>))}</tbody>
          </table>
        </div>
      )}

      {tab === "export" && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4 mt-8">
          {["teams", "round1", "round2", "round3", "leaderboard"].map((k) => (
            <button key={k} onClick={() => exportCsv(k)} data-testid={`admin-export-${k}`} className="btn-ghost">⬇ {k}.csv</button>
          ))}
        </div>
      )}
    </Shell>
  );
}

function Stat({ label, value, color = "text-mm-text", tid }) {
  return (
    <div className="mm-panel p-4" data-testid={tid}>
      <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2">{label}</div>
      <div className={`font-mono text-2xl mt-2 ${color}`}>{value}</div>
    </div>
  );
}

function Shell({ children }) {
  return (<div className="min-h-screen bg-mm-bg"><Nav /><div className="max-w-7xl mx-auto px-6 lg:px-10 py-10">{children}</div></div>);
}
