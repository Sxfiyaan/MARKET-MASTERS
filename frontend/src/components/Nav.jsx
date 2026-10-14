import React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export default function Nav() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();

  const link = (to, label, tid) => (
    <Link
      to={to}
      data-testid={tid}
      className={`text-xs font-mono tracking-widest uppercase hover:text-mm-gold transition ${loc.pathname === to ? "text-mm-gold" : "text-mm-text2"}`}
    >
      {label}
    </Link>
  );

  return (
    <nav className="w-full border-b" style={{borderColor:"var(--mm-border)", background:"rgba(7,9,14,0.75)", backdropFilter:"blur(12px)"}}>
      <div className="max-w-7xl mx-auto px-6 lg:px-10 h-16 flex items-center justify-between">
        <Link to="/" data-testid="nav-logo" className="flex items-center gap-3">
          <div className="w-7 h-7 border border-mm-gold flex items-center justify-center">
            <div className="w-2 h-2 bg-mm-gold pulse-dot" />
          </div>
          <div className="font-serif text-lg tracking-tight leading-none">
            MARKET <span className="text-mm-gold">MASTERS</span>
          </div>
        </Link>
        <div className="hidden md:flex items-center gap-7">
          {link("/", "Home", "nav-home")}
          {link("/leaderboard", "Leaderboard", "nav-leaderboard")}
          {link("/results", "Final", "nav-results")}
          {user?.role === "team" && link("/dashboard", "Dashboard", "nav-dashboard")}
          {user?.role === "admin" && link("/admin", "Admin", "nav-admin")}
        </div>
        <div className="flex items-center gap-3">
          {user ? (
            <>
              <span className="hidden md:inline text-[11px] font-mono text-mm-text2 tracking-wider">
                {user.email}
              </span>
              <button onClick={async () => { await logout(); nav("/"); }} data-testid="nav-logout" className="btn-ghost text-xs">Logout</button>
            </>
          ) : (
            <>
              <Link to="/login" data-testid="nav-login" className="btn-ghost text-xs">Login</Link>
              <Link to="/register" data-testid="nav-register" className="btn-primary text-xs">Register</Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
