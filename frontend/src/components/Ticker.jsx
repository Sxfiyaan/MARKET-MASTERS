import React from "react";

const items = [
  ["XAU/USD", "2,352.80", "+0.84%", true],
  ["EUR/USD", "1.0821", "-0.12%", false],
  ["BTC/USD", "68,420", "+2.14%", true],
  ["ETH/USD", "3,742", "+1.08%", true],
  ["GBP/USD", "1.2630", "-0.28%", false],
  ["NIFTY 50", "22,845", "+0.42%", true],
  ["S&P 500", "5,218", "+0.19%", true],
  ["AAPL", "189.21", "-0.56%", false],
  ["TSLA", "248.14", "+3.22%", true],
  ["USD/JPY", "154.60", "-0.08%", false],
];

export default function Ticker() {
  const row = (
    <div className="ticker-track font-mono text-[11px] tracking-wider py-2">
      {[...items, ...items].map((it, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="text-mm-text2">{it[0]}</span>
          <span className="text-mm-text">{it[1]}</span>
          <span className={it[3] ? "text-mm-green" : "text-mm-red"}>{it[2]}</span>
          <span className="text-mm-text2/40">|</span>
        </div>
      ))}
    </div>
  );
  return (
    <div className="w-full overflow-hidden border-y" style={{background:"var(--mm-ticker)", borderColor:"var(--mm-border)"}} data-testid="market-ticker">
      {row}
    </div>
  );
}
