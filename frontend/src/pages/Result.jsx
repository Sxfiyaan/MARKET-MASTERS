import React, { useEffect, useState } from "react";
import Nav from "@/components/Nav";
import { api } from "@/lib/api";

export default function Results() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.get("/leaderboard").then((r) => setRows((r.data.rows || []).slice(0, 10))); }, []);
  const [first, second, third, ...rest] = rows;

  const podium = (team, place, color, h) => team ? (
    <div className="flex flex-col items-center" data-testid={`podium-${place}`}>
      <div className="font-mono text-xs tracking-widest" style={{color}}>#{place}</div>
      <div className="font-serif text-3xl lg:text-4xl mt-3 text-center">{team.team_name}</div>
      <div className="text-mm-text2 text-xs font-mono mt-1">{team.college}</div>
      <div className="font-mono text-5xl mt-4" style={{color}}>{team.total}</div>
      <div className="mt-6 w-40 border border-mm-border bg-mm-panel" style={{height:h, borderTop:`3px solid ${color}`}} />
    </div>
  ) : null;

  return (
    <div className="min-h-screen bg-mm-bg">
      <Nav />
      <div className="max-w-7xl mx-auto px-6 py-16">
        <div className="text-center">
          <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// FINAL CEREMONY</div>
          <h1 className="font-serif text-5xl sm:text-7xl mt-4">THE MARKET HAS SPOKEN.</h1>
          <p className="text-mm-text2 mt-4 font-mono text-sm tracking-wider">The floor is closed. The standings are final.</p>
        </div>

        <div className="mt-16 grid grid-cols-3 gap-6 items-end max-w-4xl mx-auto">
          {podium(second, 2, "#C0C0C0", 140)}
          {podium(first,  1, "#F59E0B", 220)}
          {podium(third,  3, "#CD7F32", 110)}
        </div>

        <div className="mt-16 mm-panel mm-corner-ticks overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left font-mono text-[10px] tracking-widest text-mm-text2 border-b border-mm-border">
                <th className="p-4">RANK</th><th className="p-4">TEAM</th><th className="p-4 text-right">R1</th><th className="p-4 text-right">R2</th><th className="p-4 text-right">R3</th><th className="p-4 text-right">RISK</th><th className="p-4 text-right">TOTAL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.team_id} className="border-b border-mm-border/50">
                  <td className="p-4 font-mono text-mm-gold text-lg">#{r.rank}</td>
                  <td className="p-4 font-serif text-lg">{r.team_name}</td>
                  <td className="p-4 text-right font-mono">{r.round1}</td>
                  <td className="p-4 text-right font-mono">{r.round2}</td>
                  <td className="p-4 text-right font-mono">{r.round3}</td>
                  <td className="p-4 text-right font-mono text-mm-green">{r.risk_score}</td>
                  <td className="p-4 text-right font-mono text-lg">{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
