import React, { useMemo } from "react";

export default function CandlestickBG({ className = "" }) {
  const candles = useMemo(() => {
    const rng = (s) => () => (s = (s * 9301 + 49297) % 233280) / 233280;
    const r = rng(42);
    return Array.from({ length: 36 }).map((_, i) => {
      const up = r() > 0.45;
      const h = 40 + Math.floor(r() * 120);
      const w = 160 + Math.floor(r() * 160);
      return { i, up, body: h, wick: h + 20 + Math.floor(r() * 60), y: 40 + Math.floor(r() * (w - 60)), x: i * 32 + 20 };
    });
  }, []);
  return (
    <svg className={className} viewBox="0 0 1200 400" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="fade" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#07090E" stopOpacity="0"/>
          <stop offset="1" stopColor="#07090E" stopOpacity="1"/>
        </linearGradient>
      </defs>
      {Array.from({ length: 10 }).map((_, i) => (
        <line key={i} x1="0" x2="1200" y1={i*40} y2={i*40} stroke="#1E293B" strokeWidth="0.5" />
      ))}
      {candles.map((c) => (
        <g key={c.i} opacity="0.55">
          <line x1={c.x + 7} x2={c.x + 7} y1={c.y - 10} y2={c.y + c.wick} stroke={c.up ? "#00E676" : "#FF3B30"} strokeWidth="1"/>
          <rect x={c.x} y={c.y} width="14" height={c.body} fill={c.up ? "#00E676" : "#FF3B30"} opacity="0.75"/>
        </g>
      ))}
      <rect x="0" y="0" width="1200" height="400" fill="url(#fade)"/>
    </svg>
  );
}
