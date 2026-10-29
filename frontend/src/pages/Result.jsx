import React, { useCallback, useEffect, useRef, useState } from "react";
import Nav from "@/components/Nav";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function Results() {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [cfg, setCfg] = useState(null);
  const [lbVisible, setLbVisible] = useState(true);

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
          setLbVisible(lb.data?.visible !== false && c.data?.leaderboard_visible !== false);
          // Show all teams - no top-10 limitation in final standings flow
          setRows(lb.data?.rows || []);
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

  const userTeamId = user?.team_id || user?.team?.id;
  const userTeamName = user?.team?.team_name || user?.team_name;

  const isUserTeam = (team) => {
    if (!team) return false;
    if (userTeamId && team.team_id === userTeamId) return true;
    if (userTeamName && team.team_name === userTeamName) return true;
    return false;
  };

  const podium = (team, place, color, h) => team ? (
    <div
      className={`flex flex-col items-center ${isUserTeam(team) ? "ring-2 ring-mm-gold/60 rounded-sm p-2 bg-mm-gold/5" : ""}`}
      data-testid={`podium-${place}`}
    >
      <div className="font-mono text-xs tracking-widest" style={{color}}>#{place}</div>
      <div className="font-serif text-3xl lg:text-4xl mt-3 text-center">
        {team.team_name}
        {isUserTeam(team) && (
          <span className="block text-[10px] font-mono text-mm-gold tracking-widest mt-1">
            [YOUR TEAM]
          </span>
        )}
      </div>
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

        {!lbVisible ? (
          <div className="mt-16 mm-panel mm-corner-ticks p-10 text-center" data-testid="results-hidden-message">
            <div className="font-mono text-[11px] tracking-widest text-mm-gold">STANDINGS RESTRICTED</div>
            <div className="font-serif text-3xl mt-3">Final standings are not visible yet.</div>
            <p className="text-mm-text2 font-mono text-xs mt-3">The organizer has restricted standings visibility.</p>
          </div>
        ) : (
          <>
            {rows.length > 0 && (
              <div className="mt-16 grid grid-cols-3 gap-6 items-end max-w-4xl mx-auto">
                {podium(second, 2, "#C0C0C0", 140)}
                {podium(first,  1, "#F59E0B", 220)}
                {podium(third,  3, "#CD7F32", 110)}
              </div>
            )}

            <div className="mt-16 mm-panel mm-corner-ticks overflow-x-auto" data-testid="results-table-container">
              <table className="w-full text-sm min-w-[640px]" data-testid="final-standings-table">
                <thead>
                  <tr className="text-left font-mono text-[10px] tracking-widest text-mm-text2 border-b border-mm-border">
                    <th className="p-4">RANK</th>
                    <th className="p-4">TEAM</th>
                    <th className="p-4 text-right">R1</th>
                    <th className="p-4 text-right">R2</th>
                    <th className="p-4 text-right">R3</th>
                    <th className="p-4 text-right">RISK</th>
                    <th className="p-4 text-right">TOTAL</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const myTeam = isUserTeam(r);
                    return (
                      <tr
                        key={r.team_id}
                        className={`border-b transition-colors ${
                          myTeam
                            ? "bg-mm-gold/15 border-l-4 border-l-mm-gold border-b-mm-gold/30 font-medium"
                            : "border-mm-border/50 hover:bg-white/5"
                        }`}
                        data-testid={`standings-row-${r.rank}`}
                        data-is-user-team={myTeam ? "true" : undefined}
                      >
                        <td className="p-4 font-mono text-mm-gold text-lg">#{r.rank}</td>
                        <td className="p-4">
                          <div className="font-serif text-lg flex items-center gap-2">
                            <span>{r.team_name}</span>
                            {myTeam && (
                              <span
                                className="px-2 py-0.5 text-[10px] font-mono tracking-widest bg-mm-gold/20 text-mm-gold border border-mm-gold/40 rounded inline-block"
                                data-testid="user-team-badge"
                              >
                                YOUR TEAM
                              </span>
                            )}
                          </div>
                          {r.college && <div className="text-mm-text2 text-xs font-mono">{r.college}</div>}
                        </td>
                        <td className="p-4 text-right font-mono">{r.round1}</td>
                        <td className="p-4 text-right font-mono">{r.round2}</td>
                        <td className="p-4 text-right font-mono">{r.round3}</td>
                        <td className="p-4 text-right font-mono text-mm-green">{r.risk_score}</td>
                        <td className="p-4 text-right font-mono text-lg font-bold">{r.total}</td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan="7" className="p-10 text-center text-mm-text2 font-mono text-xs">
                        No standings recorded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
