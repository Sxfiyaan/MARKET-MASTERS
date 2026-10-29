import React, { useCallback, useEffect, useRef, useState } from "react";
import Nav from "@/components/Nav";
import { api, formatApiError } from "@/lib/api";
import { toast } from "sonner";

const Field = ({ label, tid, ...p }) => (
  <label className="block">
    <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2 mb-2">{label}</div>
    <input {...p} data-testid={tid} className="w-full px-4 py-3 font-mono text-sm bg-mm-bg border border-mm-border focus:border-mm-gold focus:outline-none" />
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
  const [submitting, setSubmitting] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState(1);
  const [form, setForm] = useState({
    asset: "",
    account_size: 100000,
    risk_per_trade: 1.5,
    result_type: "PROFIT",
    profit: 5000,
    loss: 0,
    pl_percentage: 5.0,
  });

  const skewRef = useRef(0);
  const isPollingRef = useRef(false);

  const loadStatus = useCallback(async () => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;
    try {
      const { data } = await api.get("/rounds/3/status");
      setStatus(data);

      if (data.is_paused) {
        setLeft(data.time_left ?? 0);
      } else if (data.phase_ends_at && (data.round_state === "ACTIVE" || data.status === "ACTIVE")) {
        const server = data.session?.server_time ? new Date(data.session.server_time).getTime() : Date.now();
        skewRef.current = server - Date.now();
        const end = new Date(data.phase_ends_at).getTime();
        setLeft(Math.max(0, (end - (Date.now() + skewRef.current)) / 1000));
      } else {
        setLeft(data.time_left ?? 0);
      }
    } catch (e) {
      // Ignore polling errors
    } finally {
      isPollingRef.current = false;
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 2500);
    return () => clearInterval(interval);
  }, [loadStatus]);

  // Local timer tick
  useEffect(() => {
    if (!status || status.is_paused || status.round_state !== "ACTIVE" || !status.phase_ends_at) return;
    const t = setInterval(() => {
      const end = new Date(status.phase_ends_at).getTime();
      const now = Date.now() + skewRef.current;
      const remaining = Math.max(0, (end - now) / 1000);
      setLeft(remaining);
      if (remaining <= 0 && status.round_state === "ACTIVE") {
        loadStatus();
      }
    }, 500);
  }, [status, loadStatus]);

  // Adjust default target slot to first empty slot
  useEffect(() => {
    if (!status?.trades) return;
    const t1 = status.trades.find((t) => Number(t.trade_number) === 1);
    const t2 = status.trades.find((t) => Number(t.trade_number) === 2);
    if (!t1) setSelectedSlot(1);
    else if (!t2) setSelectedSlot(2);
    else setSelectedSlot(null);
  }, [status?.trades]);

  const handleResultTypeChange = (newType) => {
    if (newType === "PROFIT") {
      setForm((prev) => ({
        ...prev,
        result_type: "PROFIT",
        loss: 0,
        profit: prev.profit <= 0 ? 5000 : prev.profit,
        pl_percentage: prev.pl_percentage <= 0 ? 5.0 : prev.pl_percentage,
      }));
    } else {
      setForm((prev) => ({
        ...prev,
        result_type: "LOSS",
        profit: 0,
        loss: prev.loss <= 0 ? 2000 : prev.loss,
        pl_percentage: prev.pl_percentage >= 0 ? -2.0 : prev.pl_percentage,
      }));
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    if (!selectedSlot) {
      toast.error("Both trade slots have already been submitted.");
      return;
    }

    const accountSize = Number(form.account_size);
    const risk = Number(form.risk_per_trade);
    const profit = Number(form.profit);
    const loss = Number(form.loss);
    const plPct = Number(form.pl_percentage);

    if (!form.asset.trim()) {
      toast.error("Please enter the asset traded on TradingView.");
      return;
    }
    if (!Number.isFinite(accountSize) || accountSize <= 0) {
      toast.error("Account size must be greater than zero.");
      return;
    }
    if (!Number.isFinite(risk) || risk < 0) {
      toast.error("Risk per trade must be non-negative.");
      return;
    }
    if (form.result_type === "PROFIT") {
      if (profit <= 0 || loss !== 0 || plPct <= 0) {
        toast.error("For PROFIT: Profit must be > 0, Loss must be 0, and P/L % must be positive.");
        return;
      }
    } else if (form.result_type === "LOSS") {
      if (loss <= 0 || profit !== 0 || plPct >= 0) {
        toast.error("For LOSS: Loss must be > 0, Profit must be 0, and P/L % must be negative.");
        return;
      }
    }

    const expectedPl = ((profit - loss) / accountSize) * 100;
    if (Math.abs(plPct - expectedPl) > 0.05) {
      toast.error(`P/L % (${plPct}%) does not match calculated return (${expectedPl.toFixed(2)}%).`);
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        trade_number: selectedSlot,
        asset: form.asset.trim().toUpperCase(),
        account_size: accountSize,
        risk_per_trade: risk,
        result_type: form.result_type,
        profit: form.result_type === "PROFIT" ? profit : 0,
        loss: form.result_type === "LOSS" ? loss : 0,
        pl_percentage: plPct,
      };

      const res = await api.post("/rounds/3/trades", payload);
      toast.success(`Trade ${res.data?.trade_number || selectedSlot} submitted! Awaiting live auditorium check.`);
      setForm({
        asset: "",
        account_size: accountSize,
        risk_per_trade: 1.5,
        result_type: "PROFIT",
        profit: 0,
        loss: 0,
        pl_percentage: 0,
      });
      await loadStatus();
    } catch (err) {
      toast.error(formatApiError(err));
      await loadStatus();
    } finally {
      setSubmitting(false);
    }
  };

  if (!status) {
    return (
      <Shell>
        <div className="font-mono text-xs text-mm-text2">Loading Round 3 status…</div>
      </Shell>
    );
  }

  const roundState = status.round_state;
  const trades = status.trades || [];
  const trade1 = trades.find((t) => Number(t.trade_number) === 1);
  const trade2 = trades.find((t) => Number(t.trade_number) === 2);
  const used = trades.length;
  const isExpired = left !== null && left <= 0;
  const isPaused = Boolean(status.is_paused);

  if (roundState === "UPCOMING") {
    return (
      <Shell>
        <div className="space-y-6">
          <Banner
            title="// ROUND 03 · WAITING ROOM"
            subtitle="The Trading Floor"
            desc="Round 3 has not started yet. Waiting for organizers to open the floor. When started, all teams share one synchronized 90-minute clock."
          />
          <Rules startingCapital={status.starting_capital} maxRisk={status.max_risk_per_trade} />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {/* Header & Shared Timer */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// ROUND 03 · THE TRADING FLOOR</div>
          <h1 className="font-serif text-4xl sm:text-5xl mt-3">90 minutes. Two trades.</h1>
        </div>
        <div className="mm-panel mm-corner-ticks px-6 py-4" data-testid="r3-timer-panel">
          <div className="font-mono text-[10px] tracking-widest text-mm-text2">
            {isPaused ? "STATUS: PAUSED" : isExpired || roundState === "COMPLETED" ? "ROUND CLOSED" : "TIME REMAINING"}
          </div>
          <div
            className={`font-mono text-5xl tracking-tighter mt-1 ${
              isPaused
                ? "text-mm-gold"
                : isExpired || roundState === "COMPLETED"
                ? "text-mm-red"
                : (left ?? 0) < 300
                ? "text-mm-red"
                : "text-mm-green"
            }`}
            data-testid="r3-timer"
          >
            {isPaused ? "PAUSED" : fmt(left ?? 0)}
          </div>
        </div>
      </div>

      {isPaused && (
        <div className="mm-panel border-mm-gold bg-mm-gold/10 p-4 mt-6 text-center font-mono text-sm text-mm-gold" data-testid="r3-paused-banner">
          ⏸ Round 3 is currently paused by organizers. Submissions are temporarily frozen.
        </div>
      )}

      {/* Overview Stats */}
      <div className="grid lg:grid-cols-4 gap-6 mt-6">
        <div className="mm-panel p-5">
          <div className="font-mono text-[10px] tracking-widest text-mm-text2">TRADES USED</div>
          <div className="font-mono text-4xl mt-2" data-testid="r3-trades-used">
            {used} <span className="text-mm-text2">/ 2</span>
          </div>
        </div>
        <div className="mm-panel p-5">
          <div className="font-mono text-[10px] tracking-widest text-mm-text2">STARTING CAPITAL</div>
          <div className="font-mono text-3xl mt-2">₹{Number(status.starting_capital || 100000).toLocaleString()}</div>
        </div>
        <div className="mm-panel p-5">
          <div className="font-mono text-[10px] tracking-widest text-mm-text2">VERIFIED R3 SCORE</div>
          <div className="font-mono text-3xl mt-2 text-mm-green" data-testid="r3-verified-score">
            {status.r3_score ?? 0}
            <span className="text-xs text-mm-text2 ml-2">/ 1000</span>
          </div>
        </div>
        <div className="mm-panel p-5">
          <div className="font-mono text-[10px] tracking-widest text-mm-text2">PROVISIONAL SCORE</div>
          <div className="font-mono text-3xl mt-2 text-mm-gold" data-testid="r3-provisional-score">
            {status.r3_provisional_score ?? 0}
            <span className="text-xs text-mm-text2 ml-2">{status.has_pending_trades ? "(Pending live review)" : "(Confirmed)"}</span>
          </div>
        </div>
      </div>

      {/* Main Content: Submission & Slots */}
      <div className="grid lg:grid-cols-5 gap-6 mt-6">
        {/* Left Column: Entry Form */}
        <div className="lg:col-span-3 mm-panel mm-corner-ticks p-6">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="font-mono text-[11px] tracking-widest text-mm-gold">
              // {selectedSlot ? `TRADE ${selectedSlot} ENTRY` : "TRADE ENTRY"}
            </div>
            <a
              href="https://www.tradingview.com/chart/"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="r3-open-tv"
              className="btn-ghost text-xs"
            >
              Open TradingView ↗
            </a>
          </div>

          {used >= 2 ? (
            <div className="mt-10 text-center py-10" data-testid="r3-limit-banner">
              <div className="font-mono text-xs tracking-widest text-mm-gold">TRADE LIMIT REACHED</div>
              <div className="font-serif text-3xl mt-3">Both trade slots have been submitted.</div>
              <div className="text-mm-text2 mt-2 text-sm font-mono">
                Organizers are checking authenticity live in the auditorium.
              </div>
            </div>
          ) : isExpired || roundState === "COMPLETED" ? (
            <div className="mt-10 text-center py-10" data-testid="r3-expired-banner">
              <div className="font-mono text-xs tracking-widest text-mm-red">ROUND CLOSED</div>
              <div className="font-serif text-3xl mt-3">The 90-minute trading window has expired.</div>
              <div className="text-mm-text2 mt-2 text-sm font-mono">
                No further trades may be submitted. Unsubmitted slots contribute 0 points.
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="mt-6 space-y-4" data-testid="r3-trade-form">
              {/* Slot selector */}
              <div className="flex items-center gap-4 p-3 border border-mm-border bg-mm-bg">
                <span className="font-mono text-xs text-mm-text2 uppercase tracking-widest">Target Slot:</span>
                <label className="flex items-center gap-2 font-mono text-xs cursor-pointer">
                  <input
                    type="radio"
                    name="trade_slot"
                    value={1}
                    disabled={Boolean(trade1)}
                    checked={selectedSlot === 1}
                    onChange={() => setSelectedSlot(1)}
                  />
                  <span className={trade1 ? "text-mm-text2 line-through" : "text-mm-text"}>
                    Slot 1 {trade1 ? "(Submitted)" : ""}
                  </span>
                </label>
                <label className="flex items-center gap-2 font-mono text-xs cursor-pointer">
                  <input
                    type="radio"
                    name="trade_slot"
                    value={2}
                    disabled={Boolean(trade2)}
                    checked={selectedSlot === 2}
                    onChange={() => setSelectedSlot(2)}
                  />
                  <span className={trade2 ? "text-mm-text2 line-through" : "text-mm-text"}>
                    Slot 2 {trade2 ? "(Submitted)" : ""}
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field
                  label="Pair / Asset"
                  tid="r3-input-asset"
                  required
                  value={form.asset}
                  onChange={(e) => setForm({ ...form, asset: e.target.value.toUpperCase() })}
                  placeholder="BTC/USDT or XAU/USD"
                />
                <Field
                  label="Account Size (₹)"
                  tid="r3-input-account"
                  required
                  type="number"
                  min={1}
                  value={form.account_size}
                  onChange={(e) => setForm({ ...form, account_size: e.target.value })}
                />
                <Field
                  label="Risk Per Trade (%)"
                  tid="r3-input-risk"
                  required
                  type="number"
                  step="0.01"
                  min={0}
                  value={form.risk_per_trade}
                  onChange={(e) => setForm({ ...form, risk_per_trade: e.target.value })}
                />
                <label className="block">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2 mb-2">Outcome</div>
                  <select
                    data-testid="r3-input-result"
                    value={form.result_type}
                    onChange={(e) => handleResultTypeChange(e.target.value)}
                    className="w-full px-4 py-3 font-mono text-sm bg-mm-bg border border-mm-border focus:border-mm-gold focus:outline-none"
                  >
                    <option value="PROFIT">PROFIT</option>
                    <option value="LOSS">LOSS</option>
                  </select>
                </label>
                <Field
                  label="Profit (₹)"
                  tid="r3-input-profit"
                  type="number"
                  step="0.01"
                  min={0}
                  disabled={form.result_type === "LOSS"}
                  value={form.profit}
                  onChange={(e) => {
                    const val = e.target.value;
                    const num = Number(val);
                    const acc = Number(form.account_size) || 100000;
                    const autoPl = Number.isFinite(num) && num > 0 && acc > 0 ? Number(((num / acc) * 100).toFixed(2)) : form.pl_percentage;
                    setForm((prev) => ({ ...prev, profit: val, pl_percentage: autoPl }));
                  }}
                />
                <Field
                  label="Loss (₹)"
                  tid="r3-input-loss"
                  type="number"
                  step="0.01"
                  min={0}
                  disabled={form.result_type === "PROFIT"}
                  value={form.loss}
                  onChange={(e) => {
                    const val = e.target.value;
                    const num = Number(val);
                    const acc = Number(form.account_size) || 100000;
                    const autoPl = Number.isFinite(num) && num > 0 && acc > 0 ? Number(((-num / acc) * 100).toFixed(2)) : form.pl_percentage;
                    setForm((prev) => ({ ...prev, loss: val, pl_percentage: autoPl }));
                  }}
                />
                <Field
                  label="P/L Percentage (%)"
                  tid="r3-input-plpct"
                  required
                  type="number"
                  step="0.01"
                  value={form.pl_percentage}
                  onChange={(e) => setForm({ ...form, pl_percentage: e.target.value })}
                  placeholder={form.result_type === "PROFIT" ? "+5.50" : "-3.20"}
                />
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={submitting || isPaused || isExpired}
                  data-testid="r3-submit-trade"
                  className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting
                    ? "Submitting…"
                    : isPaused
                    ? "Round is Paused"
                    : isExpired
                    ? "Round Expired"
                    : `Submit Trade ${selectedSlot || ""}`}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Right Column: Slot Status Cards */}
        <div className="lg:col-span-2 space-y-4">
          <SlotCard slotNumber={1} trade={trade1} />
          <SlotCard slotNumber={2} trade={trade2} />

          <div className="mm-panel p-4 font-mono text-xs text-mm-text2 space-y-2">
            <div className="text-mm-gold uppercase tracking-wider">// SCORING SUMMARY</div>
            <div>• Each trade: 60% Performance + 40% Risk score.</div>
            <div>• R3 Raw Score = (Trade 1 Score + Trade 2 Score) / 2.</div>
            <div>• Missing or rejected slots contribute 0 points.</div>
            <div>• Live verification by auditorium organizers is required.</div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function SlotCard({ slotNumber, trade }) {
  if (!trade) {
    return (
      <div className="mm-panel mm-corner-ticks p-5 border-dashed border-mm-border" data-testid={`r3-slot-${slotNumber}-empty`}>
        <div className="flex items-center justify-between">
          <div className="font-mono text-xs tracking-widest text-mm-text2">TRADE SLOT {slotNumber}</div>
          <span className="font-mono text-[10px] tracking-widest text-mm-text2">NOT SUBMITTED</span>
        </div>
        <div className="mt-4 text-sm text-mm-text2 font-mono">
          Slot open. Enter trade execution details from TradingView.
        </div>
      </div>
    );
  }

  const isVerified = trade.verification_status === "VERIFIED";
  const isRejected = trade.verification_status === "REJECTED";
  const isPending = trade.verification_status === "PENDING";

  return (
    <div
      className={`mm-panel mm-corner-ticks p-5 border ${
        isVerified ? "border-mm-green/40" : isRejected ? "border-mm-red/40" : "border-mm-gold/40"
      }`}
      data-testid={`r3-trade-row-${slotNumber}`}
    >
      <div className="flex items-center justify-between">
        <div className="font-mono text-xs tracking-widest text-mm-text">
          TRADE {slotNumber} · <span className="text-mm-gold">{trade.asset}</span>
        </div>
        <div
          className={`font-mono text-[11px] font-bold tracking-widest px-2 py-0.5 ${
            isVerified
              ? "text-mm-green bg-mm-green/10"
              : isRejected
              ? "text-mm-red bg-mm-red/10"
              : "text-mm-gold bg-mm-gold/10"
          }`}
          data-testid={`r3-trade-status-${slotNumber}`}
        >
          {trade.verification_status}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-4 font-mono text-xs">
        <div className="text-mm-text2">Risk Per Trade:</div>
        <div className="text-right text-mm-text">{trade.risk_per_trade}%</div>

        <div className="text-mm-text2">Outcome:</div>
        <div className={`text-right font-bold ${trade.result_type === "PROFIT" ? "text-mm-green" : "text-mm-red"}`}>
          {trade.result_type}
        </div>

        <div className="text-mm-text2">Profit / Loss:</div>
        <div className="text-right text-mm-text">
          {trade.result_type === "PROFIT" ? `+₹${Number(trade.profit).toLocaleString()}` : `-₹${Number(trade.loss).toLocaleString()}`}
        </div>

        <div className="text-mm-text2">P/L Return:</div>
        <div className={`text-right font-bold ${Number(trade.pl_percentage) >= 0 ? "text-mm-green" : "text-mm-red"}`}>
          {trade.pl_percentage}%
        </div>
      </div>

      {/* Score breakdown */}
      <div className="mt-4 pt-3 border-t border-mm-border/50 font-mono text-xs">
        {isVerified ? (
          <div>
            <div className="flex justify-between items-center text-mm-green font-bold">
              <span>Trade Score:</span>
              <span>{trade.trade_score} pts</span>
            </div>
            <div className="flex justify-between text-[11px] text-mm-text2 mt-1">
              <span>Perf: {trade.performance_score} (60%)</span>
              <span>Risk: {trade.risk_score} (40%)</span>
            </div>
          </div>
        ) : isPending ? (
          <div className="text-mm-gold text-center py-1">
            Provisional ({trade.trade_score} pts) — Pending live verification
          </div>
        ) : (
          <div className="text-mm-red">
            <div>Score: 0 pts (Rejected)</div>
            {trade.admin_notes && <div className="text-[11px] mt-1 text-mm-text2">Reason: {trade.admin_notes}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function Rules({ startingCapital, maxRisk }) {
  return (
    <div className="mm-panel mm-corner-ticks p-7">
      <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// ROUND 03 RULES</div>
      <h1 className="font-serif text-3xl sm:text-4xl mt-3">90 minutes. Two trades. Live floor verification.</h1>
      <ul className="mt-6 space-y-3 text-mm-text2 text-sm font-mono">
        <li>⏱ Every team shares one organizer-started 90-minute round.</li>
        <li>📊 Each team has two trade slots (Trade 1 and Trade 2).</li>
        <li>📈 Trade externally on TradingView and enter your trade details on this dashboard.</li>
        <li>🔍 Organizers check authenticity live in the auditorium and record VERIFIED or REJECTED.</li>
        <li>⚖️ Each trade is scored as: 0.60 × Performance + 0.40 × Risk Management.</li>
        <li>🏆 R3 Raw Score = (Trade 1 Score + Trade 2 Score) / 2.</li>
        <li>🚫 Only VERIFIED trades contribute. Missing or rejected slots contribute 0.</li>
        <li>⚠️ Risk &gt; 50% triggers a penalty. Manage your capital accordingly!</li>
      </ul>
    </div>
  );
}

function Banner({ title, subtitle, desc }) {
  return (
    <div className="mm-panel mm-corner-ticks p-10 text-center">
      <div className="font-mono text-[11px] tracking-widest text-mm-gold">{title}</div>
      <div className="font-serif text-3xl mt-3">{subtitle}</div>
      {desc && <div className="text-mm-text2 font-mono text-sm mt-3 max-w-xl mx-auto">{desc}</div>}
    </div>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-mm-bg">
      <Nav />
      <div className="max-w-6xl mx-auto px-6 py-12">{children}</div>
    </div>
  );
}
