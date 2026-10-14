import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import Nav from "@/components/Nav";
import { useAuth } from "@/lib/auth";

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault(); setLoading(true);
    const r = await login(email, password);
    setLoading(false);
    if (r.ok) {
      toast.success("Signed in");
      nav(r.user.role === "admin" ? "/admin" : "/dashboard");
    } else toast.error(r.error);
  };

  return (
    <div className="min-h-screen bg-mm-bg">
      <Nav />
      <div className="max-w-md mx-auto px-6 py-16">
        <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// LOGIN</div>
        <h1 className="font-serif text-5xl mt-3">Sign back in.</h1>
        <form onSubmit={onSubmit} className="mm-panel mm-corner-ticks p-7 mt-8 space-y-5" data-testid="login-form">
          <label className="block">
            <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2 mb-2">Email</div>
            <input data-testid="input-login-email" required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-4 py-3 font-mono text-sm" />
          </label>
          <label className="block">
            <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2 mb-2">Password</div>
            <input data-testid="input-login-password" required type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full px-4 py-3 font-mono text-sm" />
          </label>
          <button type="submit" disabled={loading} data-testid="submit-login" className="btn-primary w-full">{loading ? "Signing in…" : "Sign in"}</button>
          <div className="text-center">
            <Link to="/register" className="text-xs font-mono text-mm-text2 hover:text-mm-gold tracking-widest">NO ACCOUNT? REGISTER →</Link>
          </div>
        </form>
      </div>
    </div>
  );
}
