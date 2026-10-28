import React, { useCallback, useEffect, useRef, useState } from "react";
import Nav from "@/components/Nav";
import { api } from "@/lib/api";

export default function Results() {
  const [rows, setRows] = useState([]);
  const [cfg, setCfg] = useState(null);

  const inFlightPromiseRef = useRef(null);
  const latestRequestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlightPromiseRef.current) return inFlightPromiseRef.current;

    const reqId = ++latestRequestIdRef.current;
    const task = (async () => {
      try {
        const [c, lb] = await Promise.all([
          api.get("/event/config"),
          api.get("/leaderboard"),
        ]);
        if (reqId === latestRequestIdRef.current) {
          setCfg(c.data);
          setRows((lb.data?.rows || []).slice(0, 10));
        }
      } catch (e) {
        // Ignore transient errors
      } finally {
        if (inFlightPromiseRef.current === task) {
          inFlightPromiseRef.current = null;
        }
      }
    })();
    inFlightPromiseRef.current = task;
    return task;
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    const onVisibilityOrFocus = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onVisibilityOrFocus);
    document.addEventListener("visibilitychange", onVisibilityOrFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onVisibilityOrFocus);
      document.removeEventListener("visibilitychange", onVisibilityOrFocus);
    };
  }, [refresh]);

  const isFinalized = Boolean(cfg?.results_finalized);
  const [first, second, third] = rows;

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
        <div className="text-center" data-testid="results-header-container">
          <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold" data-testid="results-badge">
            {isFinalized ? "// FINAL CEREMONY" : "// CURRENT STANDINGS"}
          </div>
          <h1 className="font-serif text-5xl sm:text-7xl mt-4" data-testid="results-title">
            {isFinalized ? "THE MARKET HAS SPOKEN." : "Current Standings"}
          </h1>
          <p className="text-mm-text2 mt-4 font-mono text-sm tracking-wider" data-testid="results-subtitle">
            {isFinalized
              ? "The floor is closed. The standings are final."
              : "Active standings during live tournament play. Final standings will be declared after Round 3."}
          </p>
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
