import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Nav from "@/components/Nav";
import { api, formatApiError } from "@/lib/api";
import { toast } from "sonner";
import { Link } from "react-router-dom";

export default function Round1() {
  const [qs, setQs] = useState([]);
  const [idx, setIdx] = useState(0);
  const [submissions, setSubs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [tLeft, setTLeft] = useState(30);
  const startRef = useRef(Date.now());
  const submittedRef = useRef(false);
  const [loading, setLoading] = useState(false);

  const [qsLoaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const [a, b] = await Promise.all([api.get("/questions", { params: { round: 1 } }), api.get("/rounds/1/my-submissions")]);
      setQs(a.data); setSubs(b.data); setLoaded(true);
      const done = new Set(b.data.map((s) => s.question_id));
      const first = a.data.findIndex((q) => !done.has(q.id));
      setIdx(first === -1 ? a.data.length : first);
    })();
  }, []);

  const cur = qs[idx];
  useEffect(() => {
    if (cur) {
      startRef.current = Date.now();
      submittedRef.current = false;
      setTLeft(cur.time_limit);
      setSelected(null);
    }
  }, [cur]);
  useEffect(() => {
    if (!cur) return;
    const t = setInterval(() => setTLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, [cur]);

  const submit = useCallback(async (answer) => {
    if (!cur || loading || submittedRef.current) return;
    submittedRef.current = true;
    setLoading(true);
    const time_taken = (Date.now() - startRef.current) / 1000;
    try {
      const { data } = await api.post("/rounds/1/submit", { question_id: cur.id, answer, time_taken });
      toast[data.correct ? "success" : "error"](data.correct ? `+${data.score} pts` : "Incorrect");
      setSubs((s) => [...s, { question_id: cur.id, correct: data.correct, score: data.score }]);
      setTimeout(() => setIdx((i) => i + 1), 650);
    } catch (e) { toast.error(formatApiError(e)); }
    finally { setLoading(false); }
  }, [cur, loading]);

  useEffect(() => {
    if (cur && tLeft === 0 && !submittedRef.current) submit("");
  }, [cur, tLeft, submit]);

  const totalScore = useMemo(() => submissions.reduce((a, s) => a + (s.score || 0), 0), [submissions]);

  if (!qsLoaded) return <Shell><div className="font-mono text-sm text-mm-text2">Loading…</div></Shell>;
  if (qs.length === 0) return (
    <Shell>
      <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// ROUND 01</div>
      <h1 className="font-serif text-5xl mt-3">Awaiting the question set.</h1>
      <p className="text-mm-text2 mt-3 font-mono text-sm">The organizer hasn't published Round 1 questions yet. Hold tight.</p>
      <Link to="/dashboard" className="btn-ghost mt-10 inline-block">Back to Dashboard</Link>
    </Shell>
  );
  if (idx >= qs.length) return (
    <Shell>
      <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// ROUND 01 COMPLETE</div>
      <h1 className="font-serif text-5xl mt-3">The quiz is done.</h1>
      <div className="font-mono text-4xl mt-6 text-mm-green" data-testid="r1-final-score">{totalScore} pts</div>
      <Link to="/dashboard" data-testid="r1-back-dashboard" className="btn-ghost mt-10 inline-block">Back to Dashboard</Link>
    </Shell>
  );

  const letters = ["A", "B", "C", "D"];
  return (
    <Shell>
      <div className="flex items-center justify-between">
        <div className="font-mono text-[11px] tracking-widest text-mm-text2">QUESTION {idx + 1} / {qs.length}</div>
        <div className="font-mono text-[11px] tracking-widest">
          TIME <span className={tLeft < 10 ? "text-mm-red" : "text-mm-gold"} data-testid="r1-timer">{tLeft}s</span>
        </div>
      </div>
      <div className="mt-6 h-1 bg-mm-panel"><div className="h-full bg-mm-gold transition-all" style={{ width: `${(tLeft / cur.time_limit) * 100}%` }} /></div>
      <h2 className="font-serif text-3xl sm:text-4xl mt-10 leading-tight" data-testid="r1-question-text">{cur.text}</h2>
      <div className="grid sm:grid-cols-2 gap-4 mt-10">
        {cur.options.map((opt, i) => {
          const L = letters[i];
          const isSel = selected === L;
          return (
            <button
              key={L}
              onClick={() => { setSelected(L); submit(L); }}
              disabled={loading || tLeft === 0}
              data-testid={`r1-option-${L}`}
              className={`mm-panel mm-corner-ticks p-5 text-left transition hover:border-mm-gold ${isSel ? "border-mm-gold" : ""}`}
            >
              <div className="flex items-start gap-4">
                <div className="font-mono text-mm-gold text-2xl">{L}</div>
                <div className="text-mm-text">{opt}</div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-10 font-mono text-xs text-mm-text2">SCORE SO FAR · <span className="text-mm-text">{totalScore}</span></div>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-mm-bg">
      <Nav />
      <div className="max-w-4xl mx-auto px-6 py-14">{children}</div>
    </div>
  );
}
