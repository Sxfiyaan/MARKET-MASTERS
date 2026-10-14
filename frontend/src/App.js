import "@/App.css";
import "@/index.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "@/lib/auth";
import Landing from "@/pages/Landing";
import Register from "@/pages/Register";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Round1 from "@/pages/Round1";
import Round2 from "@/pages/Round2";
import Round3 from "@/pages/Round3";
import Leaderboard from "@/pages/Leaderboard";
import Results from "@/pages/Results";
import Admin from "@/pages/Admin";

const Protected = ({ children, role }) => {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen bg-mm-bg flex items-center justify-center text-mm-text/60 font-mono text-xs tracking-widest">AUTHENTICATING…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (role && user.role !== role) return <Navigate to="/" replace />;
  return children;
};

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster theme="dark" position="top-right" richColors closeButton />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/register" element={<Register />} />
          <Route path="/login" element={<Login />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/results" element={<Results />} />
          <Route path="/dashboard" element={<Protected role="team"><Dashboard /></Protected>} />
          <Route path="/round1" element={<Protected role="team"><Round1 /></Protected>} />
          <Route path="/round2" element={<Protected role="team"><Round2 /></Protected>} />
          <Route path="/round3" element={<Protected role="team"><Round3 /></Protected>} />
          <Route path="/admin" element={<Protected role="admin"><Admin /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
