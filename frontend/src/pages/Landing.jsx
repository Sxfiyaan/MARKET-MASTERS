import React from "react";
import { Link } from "react-router-dom";
import Nav from "@/components/Nav";
import Ticker from "@/components/Ticker";
import CandlestickBG from "@/components/candlestickBG";

const Stat = ({ label, value, trend, tid }) => (
  <div className="mm-panel mm-corner-ticks p-5" data-testid={tid}>
    <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2">{label}</div>
    <div className={`font-mono text-3xl mt-2 tracking-tighter ${trend === "up" ? "text-mm-green" : trend === "down" ? "text-mm-red" : "text-mm-text"}`}>{value}</div>
  </div>
);

const RoundCard = ({ num, title, tagline, desc, tid }) => (
  <div className="mm-panel mm-corner-ticks p-7 relative overflow-hidden group hover:border-mm-gold transition" data-testid={tid}>
    <div className="font-mono text-[11px] tracking-widest text-mm-gold">EVENT ROUND / {num}</div>
    <div className="font-serif text-5xl mt-6 leading-none">{title}</div>
    <div className="font-mono text-[11px] uppercase tracking-widest mt-5 text-mm-text2">{tagline}</div>
    <p className="mt-4 text-sm text-mm-text2 leading-relaxed">{desc}</p>
    <div className="mt-8 h-px bg-mm-border" />
    <div className="mt-5 flex items-center justify-between">
      <div className="font-mono text-[10px] tracking-widest text-mm-text2">STATUS</div>
      <div className="font-mono text-[11px] tracking-widest text-mm-green flex items-center gap-2">
        <span className="w-1.5 h-1.5 bg-mm-green pulse-dot rounded-full inline-block" /> LIVE
      </div>
    </div>
  </div>
);

export default function Landing() {
  return (
    <div className="min-h-screen bg-mm-bg text-mm-text">
      <Nav />
      <Ticker />
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 opacity-30"><CandlestickBG className="w-full h-full" /></div>
        <div className="absolute inset-0 mm-grid opacity-30" />
        <div className="relative max-w-7xl mx-auto px-6 lg:px-10 py-20 lg:py-28 grid lg:grid-cols-12 gap-10">
          <div className="lg:col-span-7">
            <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// UNIVERSITY TRADING COMPETITION — SEASON 01</div>
            <h1 className="font-serif text-5xl sm:text-6xl lg:text-7xl leading-[0.95] tracking-tight mt-6">
              THE MARKET<br/>
              <span className="italic">doesn't</span> <span className="text-mm-gold">forgive.</span>
            </h1>
            <p className="mt-7 text-mm-text2 text-base sm:text-lg max-w-xl leading-relaxed">
              Think fast. Trade smart. Manage risk. Three rounds separate the composed from the reckless. Only one team walks off the floor.
            </p>
            <div className="mt-10 flex flex-wrap gap-3">
              <Link to="/register" data-testid="hero-register-btn" className="btn-primary">Register Your Team</Link>
              <a href="#rules" data-testid="hero-rules-btn" className="btn-ghost">View Event Rules</a>
            </div>
            <div className="grid grid-cols-3 gap-3 mt-12 max-w-xl">
              <Stat label="Rounds" value="03" trend="flat" tid="stat-rounds" />
              <Stat label="Capital" value="₹1L" trend="up" tid="stat-capital" />
              <Stat label="Max Trades R3" value="02" trend="flat" tid="stat-trades" />
            </div>
          </div>
          <div className="lg:col-span-5">
            <div className="mm-panel mm-corner-ticks p-6">
              <div className="flex items-center justify-between">
                <div className="font-mono text-[10px] tracking-widest text-mm-text2">LIVE P&L / DEMO ACCOUNT</div>
                <div className="font-mono text-[10px] text-mm-green">● ONLINE</div>
              </div>
              <div className="mt-6 font-mono text-6xl tracking-tighter text-mm-green">+₹8,420</div>
              <div className="font-mono text-xs text-mm-text2 mt-2">+8.42% TODAY</div>
              <div className="mt-6 grid grid-cols-2 gap-3 text-xs font-mono">
                <div className="flex justify-between border-b border-mm-border py-2"><span className="text-mm-text2">XAU/USD</span><span className="text-mm-green">+3.20%</span></div>
                <div className="flex justify-between border-b border-mm-border py-2"><span className="text-mm-text2">EUR/USD</span><span className="text-mm-red">-1.00%</span></div>
                <div className="flex justify-between border-b border-mm-border py-2"><span className="text-mm-text2">BTC/USD</span><span className="text-mm-green">+2.14%</span></div>
                <div className="flex justify-between border-b border-mm-border py-2"><span className="text-mm-text2">AAPL</span><span className="text-mm-red">-0.56%</span></div>
              </div>
              <div className="h-px bg-mm-border my-5" />
              <div className="flex justify-between text-xs font-mono">
                <span className="text-mm-text2">RISK USED</span><span className="text-mm-gold">1.6 / 2.0%</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="rules" className="relative border-t border-mm-border">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 py-20">
          <div className="flex items-end justify-between flex-wrap gap-4">
            <div>
              <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// THREE ROUNDS</div>
              <h2 className="font-serif text-4xl sm:text-5xl mt-3">The gauntlet.</h2>
            </div>
            <div className="font-mono text-[11px] text-mm-text2 tracking-widest">R1 → R2 → R3</div>
          </div>
          <div className="grid md:grid-cols-3 gap-6 mt-10">
            <RoundCard num="01" title="THE QUIZ" tagline="KNOW THE MARKET." desc="20 finance & trading questions. Correctness × speed = score. One shot per question." tid="round-card-1" />
            <RoundCard num="02" title="THE CALL" tagline="READ THE CHART." desc="Live charts. Three choices: BUY, SELL, NO TRADE. Correct and fast earns the most." tid="round-card-2" />
            <RoundCard num="03" title="THE TRADE" tagline="90 MINUTES. TWO TRADES." desc="A 90-minute virtual trading challenge. Maximum two trades. Return alone does not win — risk management decides." tid="round-card-3" />
          </div>
        </div>
      </section>

      <section className="border-t border-mm-border">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 py-20 grid lg:grid-cols-2 gap-10 items-center">
          <div>
            <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// ROUND 03 RULES</div>
            <h2 className="font-serif text-4xl sm:text-5xl mt-3">90 minutes. Two trades. Zero mercy.</h2>
            <ul className="mt-8 space-y-4 text-mm-text2">
              {[
                ["⏱", "YOU HAVE 90 MINUTES", "The timer is server-authoritative. Refresh does not reset it."],
                ["📊", "MAXIMUM 2 TRADES", "Trade 1. Trade 2. Then the floor closes."],
                ["💰", "MANAGE YOUR CAPITAL", "Starting virtual capital is set by the organizer."],
                ["⚠️", "RISK MANAGEMENT MATTERS", "Exceed the risk ceiling, lose risk-score points."],
                ["📈", "RETURN ALONE DOES NOT WIN", "Performance × Risk Mgmt = Round 3 score."],
              ].map(([ic, t, d]) => (
                <li key={t} className="flex gap-4 items-start">
                  <span className="font-mono text-mm-gold text-lg">{ic}</span>
                  <div>
                    <div className="font-mono text-xs tracking-widest text-mm-text">{t}</div>
                    <div className="text-sm mt-1 text-mm-text2">{d}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="mm-panel mm-corner-ticks p-7">
            <div className="font-mono text-[10px] tracking-widest text-mm-text2">SCORE FORMULA / ROUND 03</div>
            <div className="font-serif text-3xl mt-4 leading-tight">
              <span className="text-mm-green">Performance</span> × 60% + <span className="text-mm-gold">Risk Mgmt</span> × 40% = <span className="italic">Round 3 Score</span>
            </div>
            <div className="h-px bg-mm-border my-6" />
            <div className="font-mono text-xs text-mm-text2 leading-7">
              <div>• Return mapped from [-5%, +10%] → [0, 1000]</div>
              <div>• Risk ≤ 1% → <span className="text-mm-green">excellent</span></div>
              <div>• Risk ≤ 2% → <span className="text-mm-gold">acceptable</span></div>
              <div>• Risk &gt; 50% → <span className="text-mm-red">penalty</span> (threshold: risk &gt; 50%, not a 50% deduction)</div>
              <div>• Weights configurable from Admin Console</div>
            </div>
            <Link to="/register" data-testid="rules-register-btn" className="btn-primary inline-block mt-8">Enter the Floor</Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-mm-border">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 py-10 flex flex-wrap justify-between items-center gap-4">
          <div className="font-serif text-xl">MARKET <span className="text-mm-gold">MASTERS</span></div>
          <div className="font-mono text-[10px] tracking-widest text-mm-text2">© SEASON 01 · THE TRADING FLOOR</div>
        </div>
      </footer>
    </div>
  );
}
