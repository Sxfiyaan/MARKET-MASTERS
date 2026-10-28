import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Nav from "@/components/Nav";
import Ticker from "@/components/Ticker";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const StateBadge = ({ state }) => {
  const map = { UPCOMING: ["text-mm-text2", "LOCKED"], ACTIVE: ["text-mm-green", "LIVE"], PAUSED: ["text-mm-gold", "PAUSED"], COMPLETED: ["text-mm-text2", "COMPLETED"] };
  const [cls, label] = map[state] || map.UPCOMING;
  return <span className={`font-mono text-[10px] tracking-widest ${cls}`}>{label}</span>;
};

const RoundTile = ({ num, title, state, href, tid, cta }) => {
  let actionElement = <button disabled className="btn-ghost opacity-50 cursor-not-allowed">Not Open</button>;
  if (state === "ACTIVE") {
    actionElement = <Link to={href} data-testid={`${tid}-enter`} className="btn-primary inline-block">{cta}</Link>;
  } else if (state === "PAUSED") {
    actionElement = <Link to={href} data-testid={`${tid}-enter`} className="btn-primary border-mm-gold text-mm-gold inline-block">Enter Round (Paused)</Link>;
  } else if (state === "UPCOMING" && (num === "01" || num === "02")) {
    actionElement = <Link to={href} data-testid={`${tid}-enter`} className="btn-ghost inline-block">Enter Waiting Room</Link>;
  } else if (state === "COMPLETED") {
    actionElement = <Link to={href} data-testid={`${tid}-enter`} className="btn-ghost inline-block">View Summary</Link>;
  }

  return (
    <div className="mm-panel mm-corner-ticks p-6" data-testid={tid}>
      <div className="flex items-start justify-between">
        <div className="font-mono text-[10px] tracking-widest text-mm-text2">ROUND / {num}</div>
        <StateBadge state={state} />
      </div>
      <div className="font-serif text-3xl mt-4">{title}</div>
      <div className="mt-6">
        {actionElement}
      </div>
    </div>
  );
};

export default function Dashboard() {
  const { user } = useAuth();
  const [cfg, setCfg] = useState(null);
  const [scores, setScores] = useState(null);
  const [announcements, setAnns] = useState([]);

  const inFlightPromiseRef = useRef(null);
  const latestRequestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    // Coalesce duplicate focus/visibility/poll requests while a refresh is already running
    if (inFlightPromiseRef.current) {
      return inFlightPromiseRef.current;
    }

    const reqId = ++latestRequestIdRef.current;
    const task = (async () => {
      try {
        const [c, s, a] = await Promise.all([
          api.get("/event/config"), api.get("/scores/me"), api.get("/announcements"),
        ]);
        // Prevent older out-of-order responses from overwriting newer state
        if (reqId === latestRequestIdRef.current) {
          setCfg(c.data);
          setScores(s.data);
          setAnns(Array.isArray(a?.data) ? a.data : []);
        }
      } catch (e) {
        // Ignore transient background refresh errors
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

    // Modest background status check (3.5s, matching Round 1 polling frequency)
    const interval = setInterval(refresh, 3500);

    // Immediate recovery when window or tab gains focus or visibility
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };
    const onFocus = () => refresh();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const rs = (n) => cfg?.rounds?.[String(n)]?.state || "UPCOMING";
  const team = user?.team;

  return (
    <div className="min-h-screen bg-mm-bg">
      <Nav /><Ticker />
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-12">
        <div className="flex items-end justify-between flex-wrap gap-6">
          <div>
            <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// PARTICIPANT DASHBOARD</div>
            <h1 className="font-serif text-5xl mt-3" data-testid="dashboard-team-name">{team?.team_name || "Team"}</h1>
            <div className="font-mono text-[11px] text-mm-text2 mt-2 tracking-widest">
              TEAM ID · <span className="text-mm-text">{team?.id?.slice(0, 8).toUpperCase()}</span> · {team?.college}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="mm-panel mm-corner-ticks p-5 min-w-[140px]">
              <div className="font-mono text-[10px] tracking-widest text-mm-text2">RANK</div>
              <div className="font-mono text-4xl mt-2 text-mm-gold" data-testid="dashboard-rank">#{scores?.rank ?? "–"}</div>
            </div>
            <div className="mm-panel mm-corner-ticks p-5 min-w-[140px]">
              <div className="font-mono text-[10px] tracking-widest text-mm-text2">TOTAL SCORE</div>
              <div className="font-mono text-4xl mt-2 text-mm-text" data-testid="dashboard-total">{scores?.total ?? 0}</div>
            </div>
            <div className="mm-panel mm-corner-ticks p-5 min-w-[140px]">
              <div className="font-mono text-[10px] tracking-widest text-mm-text2">RISK SCORE</div>
              <div className="font-mono text-4xl mt-2 text-mm-green" data-testid="dashboard-risk">{scores?.risk_score ?? 0}</div>
            </div>
          </div>
        </div>

        {announcements.length > 0 && (
          <div className="mm-panel mm-corner-ticks p-5 mt-8" data-testid="announcements">
            <div className="font-mono text-[10px] tracking-widest text-mm-gold">// BROADCAST</div>
            <ul className="mt-3 space-y-2 text-sm text-mm-text">
              {announcements.map((a) => (<li key={a.id} className="font-mono text-xs"><span className="text-mm-text2">[{new Date(a.created_at).toLocaleTimeString()}]</span> {a.message}</li>))}
            </ul>
          </div>
        )}

        <div className="grid md:grid-cols-3 gap-6 mt-10">
          <RoundTile num="01" title="THE QUIZ" state={rs(1)} href="/round1" tid="dashboard-round-1" cta="Start Round 1" />
          <RoundTile num="02" title="THE CALL" state={rs(2)} href="/round2" tid="dashboard-round-2" cta="Start Round 2" />
          <RoundTile num="03" title="THE TRADE" state={rs(3)} href="/round3" tid="dashboard-round-3" cta="Enter Round 3" />
        </div>

        <div className="grid md:grid-cols-3 gap-6 mt-6">
          <div className="mm-panel p-5"><div className="font-mono text-[10px] tracking-widest text-mm-text2">R1 SCORE</div><div className="font-mono text-3xl mt-2">{scores?.round1 ?? 0}</div></div>
          <div className="mm-panel p-5"><div className="font-mono text-[10px] tracking-widest text-mm-text2">R2 SCORE</div><div className="font-mono text-3xl mt-2">{scores?.round2 ?? 0}</div></div>
          <div className="mm-panel p-5"><div className="font-mono text-[10px] tracking-widest text-mm-text2">R3 SCORE</div><div className="font-mono text-3xl mt-2">{scores?.round3 ?? 0}</div></div>
        </div>
      </div>
    </div>
  );
}
