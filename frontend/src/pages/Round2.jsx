import React, { useEffect, useMemo, useRef, useState } from "react";
import Nav from "@/components/Nav";
import { api, formatApiError } from "@/lib/api";
import { toast } from "sonner";
import { Link } from "react-router-dom";

export default function Round2() {
  const [qs, setQs] = useState([]);
  const [idx, setIdx] = useState(0);
  const [subs, setSubs] = useState([]);
  const [tLeft, setTLeft] = useState(45);
  const startRef = useRef(Date.now());
  const [loading, setLoading] = useState(false);

  const [qsLoaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const [a, b] = await Promise.all([api.get("/questions", { params: { round: 2 } }), api.get("/rounds/2/my-submissions")]);
      setQs(a.data); setSubs(b.data); setLoaded(true);
      const done = new Set(b.data.map((s) => s.question_id));
      const first = a.data.findIndex((q) => !done.has(q.id));
      setIdx(first === -1 ? a.data.length : first);
    })();
  }, []);

  const cur = qs[idx];
  useEffect(() => { if (cur) { startRef.current = Date.now(); setTLeft(cur.time_limit); } }, [cur]);
  useEffect(() => {
    if (!cur) return;
    const t = setInterval(() => setTLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, [cur]);

  const totalScore = useMemo(() => subs.reduce((a, s) => a + (s.score || 0), 0), [subs]);

  const submit = async (answer) => {
    if (!cur || loading) return;
    setLoading(true);
    const time_taken = (Date.now() - startRef.current) / 1000;
    try {
      const { data } = await api.post("/rounds/2/submit", { question_id: cur.id, answer, time_taken });
      toast[data.correct ? "success" : "error"](data.correct ? `+${data.score} pts` : "Incorrect");
      setSubs((s) => [...s, { question_id: cur.id, score: data.score }]);
      setTimeout(() => setIdx((i) => i + 1), 650);
    } catch (e) { toast.error(formatApiError(e)); }
    finally { setLoading(false); }
  };

  if (!qsLoaded) return <Shell><div className="font-mono text-sm text-mm-text2">Loading…</div></Shell>;
  if (qs.length === 0) return (
    <Shell>
      <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// ROUND 02</div>
      <h1 className="font-serif text-5xl mt-3">Charts not posted yet.</h1>
      <p className="text-mm-text2 mt-3 font-mono text-sm">The organizer hasn't released the chart set yet. Hold tight.</p>
      <Link to="/dashboard" className="btn-ghost mt-10 inline-block">Back to Dashboard</Link>
    </Shell>
  );
  if (idx >= qs.length) return (
    <Shell>
      <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// ROUND 02 COMPLETE</div>
      <h1 className="font-serif text-5xl mt-3">Charts closed.</h1>
      <div className="font-mono text-4xl mt-6 text-mm-green" data-testid="r2-final-score">{totalScore} pts</div>
      <Link to="/dashboard" className="btn-ghost mt-10 inline-block">Back to Dashboard</Link>
    </Shell>
  );

  return (
    <Shell>
      <div className="flex items-center justify-between">
        <div className="font-mono text-[11px] tracking-widest text-mm-text2">CHART {idx + 1} / {qs.length} · {cur.asset} · {cur.timeframe}</div>
        <div className="font-mono text-[11px] tracking-widest">TIME <span className={tLeft < 10 ? "text-mm-red" : "text-mm-gold"} data-testid="r2-timer">{tLeft}s</span></div>
      </div>
      <div className="mt-5 h-1 bg-mm-panel"><div className="h-full bg-mm-gold transition-all" style={{ width: `${(tLeft / cur.time_limit) * 100}%` }} /></div>
      <div className="mm-panel mm-corner-ticks mt-7 overflow-hidden">
        <div className="aspect-[16/9] bg-black relative" data-testid="r2-chart">
          {cur.chart_image_url && <img src={cur.chart_image_url} alt={cur.asset} className="w-full h-full object-cover opacity-80" />}
          <div className="absolute top-4 left-4 font-mono text-xs tracking-widest text-mm-gold bg-black/70 px-3 py-1">{cur.asset} · {cur.timeframe}</div>
        </div>
      </div>
      <h2 className="font-serif text-2xl sm:text-3xl mt-7" data-testid="r2-question-text">{cur.text}</h2>
      <div className="grid sm:grid-cols-3 gap-4 mt-6">
        <button onClick={() => submit("BUY")} disabled={loading || tLeft === 0} data-testid="r2-btn-buy" className="mm-panel mm-corner-ticks p-5 hover:border-mm-green transition">
          <div className="font-mono text-xs tracking-widest text-mm-green">▲ LONG</div>
          <div className="font-serif text-3xl mt-2 text-mm-green">BUY</div>
        </button>
        <button onClick={() => submit("SELL")} disabled={loading || tLeft === 0} data-testid="r2-btn-sell" className="mm-panel mm-corner-ticks p-5 hover:border-mm-red transition">
          <div className="font-mono text-xs tracking-widest text-mm-red">▼ SHORT</div>
          <div className="font-serif text-3xl mt-2 text-mm-red">SELL</div>
        </button>
        <button onClick={() => submit("NO_TRADE")} disabled={loading || tLeft === 0} data-testid="r2-btn-notrade" className="mm-panel mm-corner-ticks p-5 hover:border-mm-gold transition">
          <div className="font-mono text-xs tracking-widest text-mm-gold">— WAIT</div>
          <div className="font-serif text-3xl mt-2 text-mm-gold">NO TRADE</div>
        </button>
      </div>
      <div className="mt-8 font-mono text-xs text-mm-text2">SCORE SO FAR · <span className="text-mm-text">{totalScore}</span></div>
    </Shell>
  );
}

function Shell({ children }) {
  return (<div className="min-h-screen bg-mm-bg"><Nav /><div className="max-w-5xl mx-auto px-6 py-12">{children}</div></div>);
}
