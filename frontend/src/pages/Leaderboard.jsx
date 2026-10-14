import React, { useEffect, useState } from "react";
import Nav from "@/components/Nav";
import Ticker from "@/components/Ticker";
import { api } from "@/lib/api";

const Arrow = ({ dir }) => dir === "UP" ? <span className="text-mm-green">↑</span> : dir === "DOWN" ? <span className="text-mm-red">↓</span> : dir === "NEW" ? <span className="text-mm-gold">●</span> : <span className="text-mm-text2">—</span>;

export default function Leaderboard() {
  const [rows, setRows] = useState([]);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const load = async () => { const { data } = await api.get("/leaderboard"); setRows(data.rows || []); setVisible(data.visible); };
    load(); const t = setInterval(load, 7000); return () => clearInterval(t);
  }, []);

  return (
    <div className="min-h-screen bg-mm-bg">
      <Nav /><Ticker />
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-12">
        <div className="flex items-end justify-between flex-wrap gap-6">
          <div>
            <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// LIVE LEADERBOARD</div>
            <h1 className="font-serif text-5xl mt-3">The standings.</h1>
          </div>
          <div className="font-mono text-[11px] text-mm-text2 tracking-widest">AUTO-REFRESH · <span className="text-mm-green">7s</span></div>
        </div>

        {!visible ? (
          <div className="mt-10 mm-panel mm-corner-ticks p-10 text-center">
            <div className="font-mono text-[11px] tracking-widest text-mm-gold">BOARD HIDDEN</div>
            <div className="font-serif text-3xl mt-3">The organizer has not revealed scores yet.</div>
          </div>
        ) : (
          <div className="mm-panel mm-corner-ticks mt-8 overflow-x-auto" data-testid="leaderboard-table">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left font-mono text-[10px] tracking-widest text-mm-text2 border-b border-mm-border">
                  <th className="p-4">RANK</th><th className="p-4">TEAM</th><th className="p-4">COLLEGE</th>
                  <th className="p-4 text-right">R1</th><th className="p-4 text-right">R2</th><th className="p-4 text-right">R3</th>
                  <th className="p-4 text-right">RISK</th><th className="p-4 text-right">TOTAL</th><th className="p-4 text-right">Δ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.team_id} className="border-b border-mm-border/50 hover:bg-white/5" data-testid={`lb-row-${r.rank}`}>
                    <td className="p-4 font-mono text-mm-gold text-lg">#{r.rank}</td>
                    <td className="p-4 font-serif text-lg">{r.team_name}</td>
                    <td className="p-4 text-mm-text2 text-xs">{r.college}</td>
                    <td className="p-4 text-right font-mono">{r.round1}</td>
                    <td className="p-4 text-right font-mono">{r.round2}</td>
                    <td className="p-4 text-right font-mono">{r.round3}</td>
                    <td className="p-4 text-right font-mono text-mm-green">{r.risk_score}</td>
                    <td className="p-4 text-right font-mono text-lg">{r.total}</td>
                    <td className="p-4 text-right font-mono"><Arrow dir={r.rank_change} /></td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan="9" className="p-10 text-center text-mm-text2 font-mono text-xs">No teams on the board yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
