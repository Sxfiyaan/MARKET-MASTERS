import React, { useCallback, useEffect, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { toast } from "sonner";

const emptyR1 = () => ({ round: 1, text: "", options: ["", "", "", ""], correct_answer: "A", base_points: 100, time_limit: 30, order: 0 });
const emptyR2 = () => ({ round: 2, text: "", options: ["BUY", "SELL", "NO_TRADE"], correct_answer: "BUY", base_points: 100, time_limit: 45, asset: "", timeframe: "1H", chart_image_url: "", order: 0 });

export default function QuestionsPanel({ initialRound = 1 }) {
  const [round, setRound] = useState(initialRound);
  const [qs, setQs] = useState([]);
  const [form, setForm] = useState(initialRound === 1 ? emptyR1() : emptyR2());
  const [editingId, setEditingId] = useState(null);

  const load = useCallback(async (r = round) => {
    try { const { data } = await api.get("/questions", { params: { round: r } }); setQs(data); }
    catch (e) { toast.error(formatApiError(e)); }
  }, [round]);
  useEffect(() => { load(round); setForm(round === 1 ? emptyR1() : emptyR2()); setEditingId(null); }, [load, round]);

  const save = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...form, order: +form.order, base_points: +form.base_points, time_limit: +form.time_limit };
      if (editingId) await api.put(`/questions/${editingId}`, payload);
      else await api.post("/questions", payload);
      toast.success(editingId ? "Question updated" : "Question added");
      setForm(round === 1 ? emptyR1() : emptyR2()); setEditingId(null); await load(round);
    } catch (e) { toast.error(formatApiError(e)); }
  };

  const edit = (q) => { setEditingId(q.id); setForm({ ...q, options: q.options || (round === 1 ? ["", "", "", ""] : ["BUY", "SELL", "NO_TRADE"]) }); window.scrollTo({ top: 0, behavior: "smooth" }); };

  const del = async (id) => {
    if (!window.confirm("Delete this question?")) return;
    try { await api.delete(`/questions/${id}`); toast.success("Deleted"); await load(round); }
    catch (e) { toast.error(formatApiError(e)); }
  };

  const setOpt = (i) => (e) => { const next = [...form.options]; next[i] = e.target.value; setForm({ ...form, options: next }); };

  return (
    <div className="mt-8 space-y-6" data-testid={`admin-questions-panel-r${round}`}>
      <div className="flex items-center gap-3">
        <div className="font-mono text-[11px] tracking-widest text-mm-gold">
          {round === 1 ? "// ROUND 1 · QUIZ QUESTIONS" : "// ROUND 2 · CHART QUESTIONS"}
        </div>
        <span className="font-mono text-[11px] text-mm-text2 ml-auto">{qs.length} {round === 1 ? "question" : "chart"}{qs.length === 1 ? "" : "s"} added</span>
      </div>

      <form onSubmit={save} className="mm-panel mm-corner-ticks p-6 space-y-5" data-testid="q-form">
        <div className="font-mono text-[11px] tracking-widest text-mm-gold">{editingId ? "// EDIT QUESTION" : "// ADD QUESTION"}</div>

        {round === 2 && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label="Asset / Pair" value={form.asset || ""} onChange={(e) => setForm({ ...form, asset: e.target.value.toUpperCase() })} placeholder="XAU/USD" tid="q-input-asset" required />
            <Field label="Timeframe" value={form.timeframe || ""} onChange={(e) => setForm({ ...form, timeframe: e.target.value })} placeholder="1H" tid="q-input-tf" required />
            <Field label="Order" type="number" min={0} value={form.order} onChange={(e) => setForm({ ...form, order: e.target.value })} tid="q-input-order" />
          </div>
        )}
        {round === 2 && (
          <div>
            <Field label="Chart Image URL" value={form.chart_image_url || ""} onChange={(e) => setForm({ ...form, chart_image_url: e.target.value })} placeholder="https://… screenshot URL" tid="q-input-chart" required />
            {form.chart_image_url && <img src={form.chart_image_url} alt="preview" className="mt-3 max-h-56 border border-mm-border" />}
          </div>
        )}

        <label className="block">
          <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2 mb-2">Question Prompt</div>
          <textarea data-testid="q-input-text" required rows={3} value={form.text || ""} onChange={(e) => setForm({ ...form, text: e.target.value })} className="w-full px-4 py-3 font-mono text-sm" placeholder={round === 1 ? "What does P/E stand for?" : "Describe the chart setup…"} />
        </label>

        {round === 1 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {["A", "B", "C", "D"].map((L, i) => (
              <Field key={L} label={`Option ${L}`} value={form.options[i] || ""} onChange={setOpt(i)} tid={`q-input-opt-${L}`} required />
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <label className="block">
            <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2 mb-2">Correct Answer</div>
            <select data-testid="q-input-correct" value={form.correct_answer} onChange={(e) => setForm({ ...form, correct_answer: e.target.value })} className="w-full px-4 py-3 font-mono text-sm">
              {round === 1 ? ["A", "B", "C", "D"].map((v) => <option key={v} value={v}>{v}</option>) : ["BUY", "SELL", "NO_TRADE"].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <Field label="Base Points" type="number" min={1} value={form.base_points} onChange={(e) => setForm({ ...form, base_points: e.target.value })} tid="q-input-base" required />
          <Field label="Time Limit (sec)" type="number" min={5} value={form.time_limit} onChange={(e) => setForm({ ...form, time_limit: e.target.value })} tid="q-input-time" required />
          {round === 1 && <Field label="Order" type="number" min={0} value={form.order} onChange={(e) => setForm({ ...form, order: e.target.value })} tid="q-input-order" />}
        </div>

        <div className="flex gap-3">
          <button type="submit" data-testid="q-save" className="btn-primary">{editingId ? (round === 1 ? "Update Question" : "Update Chart") : (round === 1 ? "Add Question" : "Add Chart")}</button>
          {editingId && <button type="button" onClick={() => { setEditingId(null); setForm(round === 1 ? emptyR1() : emptyR2()); }} className="btn-ghost">Cancel</button>}
        </div>
      </form>

      <div className="mm-panel mm-corner-ticks overflow-x-auto" data-testid="q-list">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left font-mono text-[10px] tracking-widest text-mm-text2 border-b border-mm-border">
              <th className="p-3">#</th>
              {round === 2 && <th className="p-3">ASSET</th>}
              <th className="p-3">QUESTION</th>
              {round === 1 && <th className="p-3">OPTIONS</th>}
              <th className="p-3">CORRECT</th>
              <th className="p-3 text-right">PTS</th>
              <th className="p-3 text-right">SEC</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {qs.map((q, i) => (
              <tr key={q.id} className="border-b border-mm-border/50 align-top" data-testid={`q-row-${q.id}`}>
                <td className="p-3 font-mono text-mm-text2">{q.order ?? i}</td>
                {round === 2 && <td className="p-3 font-mono text-xs">{q.asset}<div className="text-mm-text2">{q.timeframe}</div></td>}
                <td className="p-3 max-w-md">{q.text}</td>
                {round === 1 && (
                  <td className="p-3 text-xs">
                    {(q.options || []).map((o, j) => (<div key={j}><span className="text-mm-gold font-mono mr-2">{["A","B","C","D"][j]}</span>{o}</div>))}
                  </td>
                )}
                <td className="p-3 font-mono text-mm-green">{q.correct_answer}</td>
                <td className="p-3 text-right font-mono">{q.base_points}</td>
                <td className="p-3 text-right font-mono">{q.time_limit}</td>
                <td className="p-3 whitespace-nowrap">
                  <button onClick={() => edit(q)} data-testid={`q-edit-${q.id}`} className="text-[11px] font-mono tracking-widest text-mm-gold hover:underline mr-3">EDIT</button>
                  <button onClick={() => del(q.id)} data-testid={`q-delete-${q.id}`} className="text-[11px] font-mono tracking-widest text-mm-red hover:underline">DELETE</button>
                </td>
              </tr>
            ))}
            {qs.length === 0 && <tr><td colSpan={round === 1 ? 7 : 7} className="p-10 text-center text-mm-text2 font-mono text-xs">No questions yet. Add one above.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, tid, ...p }) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2 mb-2">{label}</div>
      <input {...p} data-testid={tid} className="w-full px-4 py-3 font-mono text-sm" />
    </label>
  );
}
