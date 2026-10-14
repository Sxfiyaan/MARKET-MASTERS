import React, { useEffect, useRef, useState } from "react";
import Nav from "@/components/Nav";
import { api, formatApiError } from "@/lib/api";
import { toast } from "sonner";

const Field = ({ label, tid, ...p }) => (
  <label className="block">
    <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2 mb-2">{label}</div>
    <input {...p} data-testid={tid} className="w-full px-4 py-3 font-mono text-sm" />
  </label>
);

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function Round3() {
  const [status, setStatus] = useState(null);
  const [left, setLeft] = useState(null);
  const [form, setForm] = useState({ asset: "", account_size: 100000, risk_per_trade: 1.5, result_type: "PROFIT", profit: 0, loss: 0, pl_percentage: 0 });
  const [submitting, setSubmitting] = useState(false);
  const skewRef = useRef(0);

  const load = async () => {
    try {
      const { data } = await api.get("/rounds/3/status");
      setStatus(data);
      if (data.session) {
        const server = new Date(data.session.server_time).getTime();
        skewRef.current = server - Date.now();
        setLeft((new Date(data.session.ends_at).getTime() - server) / 1000);
      }
    } catch (e) {}
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!status?.session) return;
    const t = setInterval(() => {
      const end = new Date(status.session.ends_at).getTime();
      const now = Date.now() + skewRef.current;
      setLeft(Math.max(0, (end - now) / 1000));
    }, 500);
    return () => clearInterval(t);
  }, [status?.session]);

  const start = async () => {
    try { await api.post("/rounds/3/start"); await load(); toast.success("Round 3 started"); }
    catch (e) { toast.error(formatApiError(e)); }
  };

  const submit = async (e) => {
    e.preventDefault(); setSubmitting(true);
    try {
      const payload = { ...form, account_size: +form.account_size, risk_per_trade: +form.risk_per_trade, profit: +form.profit, loss: +form.loss, pl_percentage: +form.pl_percentage };
      await api.post("/rounds/3/trades", payload);
      toast.success(`Trade ${status.trades.length + 1} submitted`);
      setForm({ ...form, asset: "", profit: 0, loss: 0, pl_percentage: 0 });
      await load();
    } catch (e) { toast.error(formatApiError(e)); }
    finally { setSubmitting(false); }
  };

  if (!status) return <Shell><div className="font-mono text-xs text-mm-text2">Loading…</div></Shell>;

  const roundState = status.round_state;
  const trades = status.trades || [];
  const used = trades.length;
  const max = status.max_trades;
  const limitReached = used >= max;
  const expired = left !== null && left <= 0;

  if (roundState !== "ACTIVE") return (
    <Shell>
      <Banner title="ROUND 3 NOT ACTIVE" subtitle={`Current state: ${roundState}. Wait for the organizer to start the floor.`} />
    </Shell>
  );

  if (!status.session) return (
    <Shell>
      <Rules />
      <div className="mt-8 flex justify-center">
        <button onClick={start} data-testid="r3-start-btn" className="btn-primary">Start My 1-Hour Clock</button>
      </div>
    </Shell>
  );

  return (
    <Shell>
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// ROUND 03 · THE TRADING FLOOR</div>
          <h1 className="font-serif text-4xl sm:text-5xl mt-3">One hour. Two trades.</h1>
        </div>
        <div className="mm-panel mm-corner-ticks px-6 py-4">
          <div className="font-mono text-[10px] tracking-widest text-mm-text2">TIME REMAINING</div>
          <div className={`font-mono text-5xl tracking-tighter mt-1 ${left < 300 ? "text-mm-red" : "text-mm-green"}`} data-testid="r3-timer">{fmt(left ?? 0)}</div>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6 mt-8">
        <div className="mm-panel p-5">
          <div className="font-mono text-[10px] tracking-widest text-mm-text2">TRADES USED</div>
          <div className="font-mono text-5xl mt-2" data-testid="r3-trades-used">{used} <span className="text-mm-text2">/ {max}</span></div>
        </div>
        <div className="mm-panel p-5">
          <div className="font-mono text-[10px] tracking-widest text-mm-text2">STARTING CAPITAL</div>
          <div className="font-mono text-3xl mt-2">₹{status.starting_capital.toLocaleString()}</div>
        </div>
        <div className="mm-panel p-5">
          <div className="font-mono text-[10px] tracking-widest text-mm-text2">MAX RISK / TRADE</div>
          <div className="font-mono text-3xl mt-2 text-mm-gold">{status.max_risk_per_trade}%</div>
        </div>
      </div>

      <div className="grid lg:grid-cols-5 gap-6 mt-6">
        <div className="lg:col-span-3 mm-panel mm-corner-ticks p-6">
          <div className="flex items-center justify-between">
            <div className="font-mono text-[11px] tracking-widest text-mm-gold">// TRADE {used + 1} ENTRY</div>
            <a href="https://www.tradingview.com/chart/" target="_blank" rel="noopener noreferrer" data-testid="r3-open-tv" className="btn-ghost text-xs">Open TradingView ↗</a>
          </div>
          {limitReached ? (
            <div className="mt-10 text-center py-10" data-testid="r3-limit-banner">
              <div className="font-mono text-xs tracking-widest text-mm-gold">TRADE LIMIT REACHED</div>
              <div className="font-serif text-3xl mt-3">You've used your two shots.</div>
              <div className="text-mm-text2 mt-2 text-sm">Return to the dashboard. Risk-management decides who wins.</div>
            </div>
          ) : expired ? (
            <div className="mt-10 text-center py-10">
              <div className="font-mono text-xs tracking-widest text-mm-red">ROUND CLOSED</div>
              <div className="font-serif text-3xl mt-3">The window has closed.</div>
            </div>
          ) : (
            <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-5 mt-6" data-testid="r3-trade-form">
              <Field label="Pair / Asset" tid="r3-input-asset" required value={form.asset} onChange={(e) => setForm({ ...form, asset: e.target.value.toUpperCase() })} placeholder="XAU/USD" />
              <Field label="Account Size (₹)" tid="r3-input-account" required type="number" min={1} value={form.account_size} onChange={(e) => setForm({ ...form, account_size: e.target.value })} />
              <Field label="Risk Per Trade (%)" tid="r3-input-risk" required type="number" step="0.01" min={0} value={form.risk_per_trade} onChange={(e) => setForm({ ...form, risk_per_trade: e.target.value })} />
              <label className="block">
                <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2 mb-2">Result</div>
                <select data-testid="r3-input-result" value={form.result_type} onChange={(e) => setForm({ ...form, result_type: e.target.value })} className="w-full px-4 py-3 font-mono text-sm">
                  <option value="PROFIT">PROFIT</option>
                  <option value="LOSS">LOSS</option>
                </select>
              </label>
              <Field label="Profit (₹)" tid="r3-input-profit" type="number" step="0.01" min={0} value={form.profit} onChange={(e) => setForm({ ...form, profit: e.target.value })} />
              <Field label="Loss (₹)" tid="r3-input-loss" type="number" step="0.01" min={0} value={form.loss} onChange={(e) => setForm({ ...form, loss: e.target.value })} />
              <Field label="P/L Percentage (%)" tid="r3-input-plpct" required type="number" step="0.01" value={form.pl_percentage} onChange={(e) => setForm({ ...form, pl_percentage: e.target.value })} />
              <div className="flex items-end">
                <button type="submit" disabled={submitting} data-testid="r3-submit-trade" className="btn-primary w-full">{submitting ? "Submitting…" : `Submit Trade ${used + 1}`}</button>
              </div>
            </form>
          )}
        </div>

        <div className="lg:col-span-2 mm-panel mm-corner-ticks p-6">
          <div className="font-mono text-[11px] tracking-widest text-mm-gold">// MY TRADES</div>
          {trades.length === 0 ? (
            <div className="text-mm-text2 text-sm mt-6 font-mono">No trades submitted yet.</div>
          ) : (
            <ul className="space-y-4 mt-5">
              {trades.map((t) => (
                <li key={t.id} className="border border-mm-border p-4" data-testid={`r3-trade-row-${t.trade_number}`}>
                  <div className="flex items-center justify-between">
                    <div className="font-mono text-xs tracking-widest text-mm-text2">TRADE {t.trade_number} · {t.asset}</div>
                    <div className={`font-mono text-[10px] tracking-widest ${t.verification_status === "VERIFIED" ? "text-mm-green" : t.verification_status === "REJECTED" ? "text-mm-red" : "text-mm-gold"}`}>{t.verification_status}</div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs">
                    <div className="text-mm-text2">Risk</div><div>{t.risk_per_trade}%</div>
                    <div className="text-mm-text2">Result</div><div className={t.result_type === "PROFIT" ? "text-mm-green" : "text-mm-red"}>{t.result_type}</div>
                    <div className="text-mm-text2">P/L</div><div className={t.pl_percentage >= 0 ? "text-mm-green" : "text-mm-red"}>{t.pl_percentage}%</div>
                  </div>
                  {t.admin_notes && <div className="mt-2 text-[11px] text-mm-text2 font-mono">Note: {t.admin_notes}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Rules() {
  return (
    <div className="mm-panel mm-corner-ticks p-7">
      <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// ROUND 03 RULES</div>
      <h1 className="font-serif text-4xl mt-3">One hour. Two trades. Zero mercy.</h1>
      <ul className="mt-6 space-y-3 text-mm-text2 text-sm font-mono">
        <li>⏱ Your personal 1-hour timer starts when you click <span className="text-mm-text">Start</span>.</li>
        <li>📊 You may submit a maximum of 2 trades.</li>
        <li>💰 Manage your capital. Starting capital is set by the organizer.</li>
        <li>⚠️ Risk per trade is capped. Excessive risk incurs penalties.</li>
        <li>📈 Return alone does not win — risk management counts.</li>
        <li>🔒 Trades are server-validated and sent to the admin for verification.</li>
      </ul>
    </div>
  );
}

function Banner({ title, subtitle }) {
  return (
    <div className="mm-panel mm-corner-ticks p-10 text-center">
      <div className="font-mono text-[11px] tracking-widest text-mm-gold">{title}</div>
      <div className="font-serif text-3xl mt-3">{subtitle}</div>
    </div>
  );
}

function Shell({ children }) {
  return (<div className="min-h-screen bg-mm-bg"><Nav /><div className="max-w-6xl mx-auto px-6 py-12">{children}</div></div>);
}
