import React from "react";
import Round3 from "../pages/Round3";

describe("Round 3 Synchronized Client Tests", () => {
  test("imports production Round3 component successfully", () => {
    expect(typeof Round3).toBe("function");
    expect(Round3.name).toBe("Round3");
  });

  test("Round 3 source code confirms 90 minutes rules and eliminates 1 hour references", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.resolve(__dirname, "../pages/Round3.jsx"), "utf8");

    // Must contain 90 minutes
    expect(source).toMatch(/90 minutes/i);

    // Must NOT contain "One hour" or "1-hour" or "1 hour"
    expect(source).not.toMatch(/one hour/i);
    expect(source).not.toMatch(/1-hour/i);
    expect(source).not.toMatch(/1 hour/i);
  });

  test("Profit / Loss coherence rules", () => {
    // PROFIT: profit > 0, loss === 0, pl_percentage > 0
    const profitValid = (profit, loss, pl) => profit > 0 && loss === 0 && pl > 0;
    expect(profitValid(5000, 0, 5.0)).toBe(true);
    expect(profitValid(5000, 100, 5.0)).toBe(false);
    expect(profitValid(5000, 0, -2.0)).toBe(false);
    expect(profitValid(0, 0, 5.0)).toBe(false);

    // LOSS: loss > 0, profit === 0, pl_percentage < 0
    const lossValid = (profit, loss, pl) => loss > 0 && profit === 0 && pl < 0;
    expect(lossValid(0, 2000, -2.0)).toBe(true);
    expect(lossValid(500, 2000, -2.0)).toBe(false);
    expect(lossValid(0, 2000, 1.0)).toBe(false);
    expect(lossValid(0, 0, -2.0)).toBe(false);
  });

  test("P/L percentage agrees with 100 * (profit - loss) / account_size within 0.05% tolerance", () => {
    const calcExpectedPl = (profit, loss, accountSize) => ((profit - loss) / accountSize) * 100;
    const isWithinTolerance = (submittedPl, expectedPl, tol = 0.05) => Math.abs(submittedPl - expectedPl) <= tol;

    // Standard cases
    const exp1 = calcExpectedPl(5000, 0, 100000); // 5.0%
    expect(exp1).toBe(5.0);
    expect(isWithinTolerance(5.0, exp1)).toBe(true);
    expect(isWithinTolerance(5.04, exp1)).toBe(true); // within 0.05%
    expect(isWithinTolerance(5.06, exp1)).toBe(false); // exceeds 0.05%

    // Repeating decimal case: 1000 profit on 30000 account size = 3.3333...%
    const exp2 = calcExpectedPl(1000, 0, 30000);
    expect(isWithinTolerance(3.33, exp2)).toBe(true); // difference ~0.0033% <= 0.05%

    // Loss case: -2000 loss on 100000 account size = -2.0%
    const exp3 = calcExpectedPl(0, 2000, 100000);
    expect(exp3).toBe(-2.0);
    expect(isWithinTolerance(-2.0, exp3)).toBe(true);
    expect(isWithinTolerance(-2.03, exp3)).toBe(true);
    expect(isWithinTolerance(-2.1, exp3)).toBe(false);
  });

  test("Finite values and account size requirements", () => {
    const isValidNumericInput = (accountSize, risk, profit, loss, pl) =>
      Number.isFinite(accountSize) &&
      accountSize > 0 &&
      Number.isFinite(risk) &&
      risk >= 0 &&
      Number.isFinite(profit) &&
      profit >= 0 &&
      Number.isFinite(loss) &&
      loss >= 0 &&
      Number.isFinite(pl);

    expect(isValidNumericInput(100000, 1.5, 5000, 0, 5.0)).toBe(true);
    expect(isValidNumericInput(0, 1.5, 5000, 0, 5.0)).toBe(false); // account size <= 0
    expect(isValidNumericInput(-10000, 1.5, 5000, 0, 5.0)).toBe(false); // negative account size
    expect(isValidNumericInput(NaN, 1.5, 5000, 0, 5.0)).toBe(false); // NaN
    expect(isValidNumericInput(100000, Infinity, 5000, 0, 5.0)).toBe(false); // Infinity
    expect(isValidNumericInput(100000, 1.5, -100, 0, 5.0)).toBe(false); // negative profit
  });

  test("Landing page confirms 90 minutes rules, eliminates 1 hour references, and updates risk penalty threshold", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.resolve(__dirname, "../pages/Landing.jsx"), "utf8");

    // Must contain 90 minutes for Round 3
    expect(source).toMatch(/90 minutes/i);

    // Must NOT contain "One hour" or "1 hour" or "1-hour"
    expect(source).not.toMatch(/one hour/i);
    expect(source).not.toMatch(/1 hour/i);
    expect(source).not.toMatch(/1-hour/i);

    // Outdated "Risk > 2% → penalty" must be replaced with "Risk > 50% → penalty"
    expect(source).not.toMatch(/risk\s*(?:>|&gt;)\s*2%\s*→\s*penalty/i);
    expect(source).toMatch(/risk\s*(?:>|&gt;)\s*50%\s*→/i);

    // Preserves legitimate references to max_risk (1% and 2%) used by bonus/loss formulas
    expect(source).toMatch(/risk\s*≤\s*1%/i);
    expect(source).toMatch(/risk\s*≤\s*2%/i);
  });

  test("Round 3 page confirms exact Risk > 50% penalty threshold description", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.resolve(__dirname, "../pages/Round3.jsx"), "utf8");

    expect(source).toMatch(/risk\s*(?:>|&gt;)\s*50%\s*→\s*penalty/i);
    expect(source).toMatch(/exactly 50% does not trigger penalty/i);
  });

  test("Admin Finalize Results button source confirms outlined styling, keyboard focus, and in-flight guard", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.resolve(__dirname, "../pages/Admin.jsx"), "utf8");

    // Button uses outlined btn-ghost style with gold accent
    expect(source).toMatch(/btn-ghost border-mm-gold text-mm-gold/);

    // Button provides keyboard focus ring
    expect(source).toMatch(/focus:ring-2 focus:ring-mm-gold/);

    // Button prevents repeated clicks via actionInProgress and disabled state
    expect(source).toMatch(/actionInProgress/);
    expect(source).toMatch(/disabled=\{Boolean\(actionInProgress\)\}/);
    expect(source).toMatch(/actionInProgress === "finalize" \? "Finalizing…" : "★ Finalize Results"/);
  });
});
