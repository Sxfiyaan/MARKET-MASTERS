import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { toast } from "sonner";
import Nav from "@/components/Nav";
import { useAuth } from "@/lib/auth";

const Field = ({ label, tid, error, ...props }) => (
  <label className="block">
    <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2 mb-2">{label}</div>
    <input {...props} data-testid={tid} className={`w-full px-4 py-3 font-mono text-sm ${error ? "border border-mm-red focus:border-mm-red" : ""}`} />
    {error && <div className="text-xs text-mm-red font-mono mt-1" data-testid={`${tid}-error`}>{error}</div>}
  </label>
);

export default function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ team_name: "", leader_name: "", leader_email: "", leader_phone: "", college: "", password: "", m2: "", m3: "", m4: "" });
  const [phoneError, setPhoneError] = useState("");
  const [loading, setLoading] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const onPhoneChange = (e) => {
    // Only accept numeric digits up to 10 characters, preserving leading zeros as string
    const cleaned = e.target.value.replace(/\D/g, "").slice(0, 10);
    setF((prev) => ({ ...prev, leader_phone: cleaned }));
    if (cleaned.length > 0 && cleaned.length < 10) {
      setPhoneError("Phone number must be exactly 10 digits");
    } else {
      setPhoneError("");
    }
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!/^\d{10}$/.test(f.leader_phone)) {
      setPhoneError("Phone number must be exactly 10 digits");
      return;
    }
    setPhoneError("");
    setLoading(true);
    const members = [f.m2, f.m3, f.m4].filter(Boolean);
    const r = await register({ ...f, members });
    setLoading(false);
    if (r.ok) {
      toast.success("Team registered");
      nav("/dashboard");
    } else {
      if (r.error && r.error.toLowerCase().includes("phone")) {
        setPhoneError(r.error);
      }
      toast.error(r.error);
    }
  };

  return (
    <div className="min-h-screen bg-mm-bg">
      <Nav />
      <div className="max-w-3xl mx-auto px-6 py-14">
        <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// TEAM REGISTRATION</div>
        <h1 className="font-serif text-5xl mt-3">Join the floor.</h1>
        <p className="text-mm-text2 mt-3">Register your university team. One lead account per team.</p>
        <form onSubmit={onSubmit} className="mm-panel mm-corner-ticks p-7 mt-8 grid grid-cols-1 md:grid-cols-2 gap-5" data-testid="register-form">
          <Field label="Team Name" tid="input-team-name" required value={f.team_name} onChange={set("team_name")} placeholder="Alpha Traders" />
          <Field label="College / University" tid="input-college" required value={f.college} onChange={set("college")} placeholder="IIM Example" />
          <Field label="Team Leader Name" tid="input-leader-name" required value={f.leader_name} onChange={set("leader_name")} placeholder="Jane Doe" />
          <Field
            label="Leader Phone"
            tid="input-leader-phone"
            required
            type="tel"
            inputMode="numeric"
            pattern="[0-9]{10}"
            maxLength={10}
            value={f.leader_phone}
            onChange={onPhoneChange}
            error={phoneError}
            placeholder="0987654321"
          />
          <Field label="Leader Email (login)" tid="input-leader-email" required type="email" value={f.leader_email} onChange={set("leader_email")} placeholder="jane@college.edu" />
          <Field label="Password" tid="input-password" required type="password" minLength={6} value={f.password} onChange={set("password")} placeholder="Minimum 6 chars" />
          <Field label="Member 2 (optional)" tid="input-m2" value={f.m2} onChange={set("m2")} />
          <Field label="Member 3 (optional)" tid="input-m3" value={f.m3} onChange={set("m3")} />
          <Field label="Member 4 (optional)" tid="input-m4" value={f.m4} onChange={set("m4")} />
          <div className="md:col-span-2 flex items-center justify-between pt-3">
            <Link to="/login" className="text-xs font-mono text-mm-text2 hover:text-mm-gold tracking-widest">ALREADY REGISTERED? LOGIN →</Link>
            <button type="submit" disabled={loading} data-testid="submit-register" className="btn-primary">{loading ? "Submitting…" : "Register Team"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
